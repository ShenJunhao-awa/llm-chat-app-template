/**
 * LLM Chat Application Template — AI Judge Edition
 *
 * Dual-purpose: general chatbot (streaming) + content judge (JSON-only).
 * The /api/judge endpoint is designed to be called by the CloudForum frontend
 * to review post content before publishing.
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt for chat
const CHAT_SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

// Strict system prompt for content judge
const JUDGE_SYSTEM_PROMPT = `你是一个论坛帖子内容审核助手。用户会提交一段帖子文本，你需要判断是否包含违规内容。

【必须放行的内容（正常讨论，不算违规）】
- 吐槽任何产品或服务体验差、优化差、有Bug、价格贵
- 表达对厂商、公司、开发者的不满或失望
- 正常的情绪宣泄、抱怨日常——只要不是针对论坛用户的辱骂
- 讨论硬件配置、游戏帧数、画质等技术话题
- 对任何作品给出差评、负面评价

【真正的违规内容（才需要拦截）】
- 色情：露骨的性描写、色情资源链接
- 暴力：宣扬杀人、伤害他人、恐怖袭击
- 政治敏感：违反中国法律法规的政治言论
- 人身攻击：针对论坛其他用户的辱骂、诅咒、威胁
- 垃圾广告：刷屏、卖货、推广链接
- 欺诈：骗钱、虚假信息、钓鱼网站

【核心原则】
- 任何对产品/服务/公司的批评吐槽 → 放行
- 针对论坛其他用户的恶意攻击 → 拦截
- 不确定的时候 → 放行

【输出格式要求】
- 如果内容安全，只返回：{"status":"pass"}
- 如果内容违规，返回：{"status":"reject","reason":"具体的违规原因"}

严禁返回任何其他文字、解释或Markdown格式。只返回纯JSON对象。`;

/** CORS headers for cross-origin requests from the forum */
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "https://forum.jgp.dpdns.org",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					...CORS_HEADERS,
					"Access-Control-Allow-Origin":
						request.headers.get("Origin") || CORS_HEADERS["Access-Control-Allow-Origin"],
				},
			});
		}

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChatRequest(request, env);
		}

		if (url.pathname === "/api/judge" && request.method === "POST") {
			return handleJudgeRequest(request, env);
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests (streaming, general-purpose chatbot)
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: CHAT_SYSTEM_PROMPT });
		}

		const stream = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
			messages,
			max_tokens: 1024,
			stream: true,
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Handles judge API requests (non-streaming, returns pass/reject JSON)
 *
 * Called by the forum frontend before publishing a post:
 * 1. Forum sends post content to /api/judge
 * 2. AI returns {"status":"pass"} or {"status":"reject"}
 * 3. Forum decides whether to publish based on result
 */
async function handleJudgeRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { content } = (await request.json()) as { content: string };

		if (!content || typeof content !== "string" || content.trim().length === 0) {
			return new Response(
				JSON.stringify({ error: "Content is required" }),
				{
					status: 400,
					headers: {
						"content-type": "application/json",
						...CORS_HEADERS,
						"Access-Control-Allow-Origin":
							request.headers.get("Origin") || CORS_HEADERS["Access-Control-Allow-Origin"],
					},
				},
			);
		}

		// Call AI with judge system prompt — non-streaming since output is tiny JSON
		const result = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
			messages: [
				{ role: "system", content: JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: content },
			],
			max_tokens: 50, // Only needs to output {"status":"pass"} — ~20 tokens
			stream: false,
		});

		// Extract the response text
		const rawResponse = typeof result === "object" && result !== null
			? (result as any).response || ""
			: String(result);

		// Try to parse the JSON from the AI response
		let status: "pass" | "reject" = "pass"; // Default to pass if parsing fails
		let reason: string | undefined;
		try {
			const parsed = JSON.parse(rawResponse.trim());
			if (parsed.status === "pass" || parsed.status === "reject") {
				status = parsed.status;
				reason = parsed.reason;
			}
		} catch {
			// If AI didn't return valid JSON, try to extract from the raw text
			const cleaned = rawResponse.trim();
			if (cleaned.includes('"reject"') || cleaned.includes("reject")) {
				status = "reject";
			}
			// Otherwise keep default "pass"
		}

		const responseBody: Record<string, any> = { status };
		if (reason) responseBody.reason = reason;

		return new Response(
			JSON.stringify(responseBody),
			{
				headers: {
					"content-type": "application/json",
					...CORS_HEADERS,
					"Access-Control-Allow-Origin":
						request.headers.get("Origin") || CORS_HEADERS["Access-Control-Allow-Origin"],
				},
			},
		);
	} catch (error) {
		console.error("Error processing judge request:", error);
		return new Response(
			JSON.stringify({ status: "pass", error: "审核服务异常，已默认放行" }),
			{
				status: 200, // Return 200 to avoid blocking the post — fail open
				headers: {
					"content-type": "application/json",
					...CORS_HEADERS,
					"Access-Control-Allow-Origin":
						request.headers.get("Origin") || CORS_HEADERS["Access-Control-Allow-Origin"],
				},
			},
		);
	}
}
