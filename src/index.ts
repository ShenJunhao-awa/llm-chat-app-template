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
const SYSTEM_PROMPT = `你是一个严格的帖子内容审核助手。

【审核规则】
判断用户提交的文本是否包含以下违规内容：
1. 色情低俗
2. 暴力恐怖
3. 政治敏感
4. 人身攻击/辱骂
5. 垃圾广告/欺诈信息

【输出格式要求（严格遵守）】
- 如果内容安全，只返回 JSON：{"status":"pass"}
- 如果内容违规，必须返回 JSON：{"status":"reject", "reason":"违规类型", "violation_phrase":"原样摘抄的违规词或短句"}
- 其中 "reason" 填写违规类型（如"人身攻击"），"violation_phrase" 必须原样复制用户帖子中的具体违规词语，多个用顿号或逗号分隔。
- 严禁返回任何其他文字、解释或Markdown，只返回纯JSON对象。

【示例】
用户输入："你这个蠢货，滚出去"
输出：{"status":"reject", "reason":"人身攻击", "violation_phrase":"蠢货、滚出去"}`;

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
				{ role: "system", content: SYSTEM_PROMPT },
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
		let violationPhrase: string | undefined;
		try {
			const parsed = JSON.parse(rawResponse.trim());
			if (parsed.status === "pass" || parsed.status === "reject") {
				status = parsed.status;
				reason = parsed.reason;
				violationPhrase = parsed.violation_phrase;
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
		if (violationPhrase) responseBody.violation_phrase = violationPhrase;

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
