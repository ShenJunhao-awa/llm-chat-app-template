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
const SYSTEM_PROMPT = `你是一个内容审核助手。拦截明显违规的内容，不确定的放行。

输入格式：用户发来的内容是【标题】和【正文】两部分。

审核步骤：
1. 先看【标题】——有违规记一条
2. 再看【正文】——有违规记一条
3. 合并输出，标题正文互不影响，不要漏

必须拦截的违规类型（必须明显才拦）：
- 宣扬法西斯主义、纳粹、军国主义、分裂主义等被法律禁止的意识形态
- 人身攻击：直接辱骂特定用户
- 露骨色情：性行为细节描写
- 刷屏广告：纯商业广告、诈骗信息
- 暴力威胁：宣扬杀人伤害

以下情况一律放行，不拦截：
- 图片视频链接、资源分享链接
- 吐槽产品、网络用语、脏话（无特定攻击对象时）
- 普通政治讨论、爱国表达
- 不确定的全都放行

输出格式：
- 安全：{"status":"pass"}
- 违规：{"status":"reject", "violations":[{"reason":"2-6字概括", "violation_phrase":"原样抄写违规词句"}]}
- 多个不同类型违规就分多条，同一意图合并为一条
- 只返回JSON`;

/** CORS headers for cross-origin requests from the forum */
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "https://forum.jgp.dpdns.org",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, x-judge-key",
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

		// 站点访问密码验证
		if (url.pathname === "/api/verify-site" && request.method === "POST") {
			return handleVerifySite(request, env);
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
 * Handles site access verification
 * Simple password gate to prevent public access to the website
 */
async function handleVerifySite(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { password } = (await request.json()) as { password: string };
		const sitePassword = env.SITE_PASSWORD || "Jihao0318";

		if (password === sitePassword) {
			return new Response(
				JSON.stringify({ success: true }),
				{ headers: { "content-type": "application/json" } },
			);
		}

		return new Response(
			JSON.stringify({ success: false, error: "密码错误" }),
			{ status: 401, headers: { "content-type": "application/json" } },
		);
	} catch {
		return new Response(
			JSON.stringify({ success: false, error: "请求格式错误" }),
			{ status: 400, headers: { "content-type": "application/json" } },
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

		// 校验密钥：必须携带 x-judge-key 头
		const judgeKey = request.headers.get("x-judge-key");
		if (!judgeKey || judgeKey !== "Jihao0318") {
			return new Response(
				JSON.stringify({ error: "未授权，请提供有效的审核密钥" }),
				{
					status: 401,
					headers: {
						"content-type": "application/json",
						...CORS_HEADERS,
						"Access-Control-Allow-Origin":
							request.headers.get("Origin") || CORS_HEADERS["Access-Control-Allow-Origin"],
					},
				},
			);
		}

		// 拆分标题和正文（第一行是标题，后面是正文）
		const lines = content.split('\n');
		const title = lines[0] || '';
		const body = lines.slice(1).join('\n').trim();

		// Call AI with judge system prompt — non-streaming since output is tiny JSON
		const result = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `【标题】${title}\n【正文】${body || '（无正文）'}` },
			],
			max_tokens: 1024, // 长文章也需要完整审核
			temperature: 0, // 温度=0 保证每次输出一致
			stream: false,
		});

		// Extract the response text
		const rawResponse = typeof result === "object" && result !== null
			? (result as any).response || ""
			: String(result);

		// Try to parse the JSON from the AI response
		let status: "pass" | "reject" = "pass"; // Default to pass if parsing fails
		let violations: { reason: string; violation_phrase: string }[] = [];
		let reason: string | undefined;
		let violationPhrase: string | undefined;
		try {
			const parsed = JSON.parse(rawResponse.trim());
			if (parsed.status === "pass" || parsed.status === "reject") {
				status = parsed.status;
				// 优先使用 violations 数组（新格式），其次用单条 reason/violation_phrase（旧格式兼容）
				if (Array.isArray(parsed.violations) && parsed.violations.length > 0) {
					violations = parsed.violations;
				} else {
					reason = parsed.reason;
					violationPhrase = parsed.violation_phrase;
				}
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
		if (violations.length > 0) {
			responseBody.violations = violations;
		} else {
			if (reason) responseBody.reason = reason;
			if (violationPhrase) responseBody.violation_phrase = violationPhrase;
		}

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
