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
const SYSTEM_PROMPT = `你是一个内容审核助手。你的任务是检查文本中是否有违规内容。如果有多处违规，**必须全部列出**。

【必须放行的情况（看到这些不要拦截）】
- 吐槽、抱怨任何产品、服务、游戏、软件体验差
- 对厂商、公司、开发者表达不满或失望
- 讨论技术问题、配置、帧数、优化
- 使用网络流行语、口语化表达、语气词
- 常见的口语化赞美/感叹词如"牛逼""牛B""太牛了""牛批"等，都算正常网络用语，**不是人身攻击**
- 给负面评价、差评
- 正常的情绪宣泄，不针对具体论坛用户
- **爱国内容、歌颂国家/政党/社会主义的正面表达** ← 强调：这不违规
- **分享正常资源链接**（如软件下载、资料参考、项目地址等），只要不是明显的营销广告或欺诈链接 ← 强调：这不违规

【只有以下情况才拦截】
- 明确的色情内容：露骨的性行为描写、色情网站链接
- 暴力恐怖：宣扬杀人、伤害、恐怖活动
- 政治敏感：只有明确宣扬被中国法律禁止的意识形态（如法西斯主义、军国主义、分裂主义）才拦截，**普通政治讨论、爱国表达、歌颂社会主义都不算政治敏感**
- 人身攻击：针对论坛中其他用户的直接辱骂、诅咒、威胁、咒骂家人（如"去死""全家死光""妈的""操你妈"等，必须有明确的攻击对象）
- 广告欺诈：明显的商业刷屏广告、骗钱信息、钓鱼链接。**分享资源链接、项目地址、参考资料等都不算广告**
- ⚠️ **注意谐音（同音字）替换**：很多人会用同音字/谐音来绕过审核，比如"大调查"可能是"大屌插"的谐音、"草你妈"可能是"操你妈"的谐音、"sb"可能是"傻逼"的缩写。遇到疑似谐音/缩写的违规词，也要拦截，violation_phrase 里写上实际对应词并标注「谐音」

【判断原则 - 像大厂审核一样思考】
- "这个游戏真垃圾" → 放行（批评产品）
- "开发者脑子有病吧" → 放行（批评厂商，非针对论坛用户）
- "你真是个白痴"（回复某人）→ 拦截（针对具体用户的人身攻击）
- "你们的妈都死了" → 拦截（针对用户及其家人的辱骂）
- "法西斯主义万岁" → 拦截（宣扬被禁意识形态）
- "中国万岁" → 放行（爱国表达，不违规）
- "社会主义万岁" → 放行（歌颂制度，不违规）
- "共产党好" → 放行（正面表达，不违规）
- "傻逼游戏" → 放行（骂游戏）
- "傻逼楼主" → 拦截（骂人）
- "太逆天了" → 放行（网络用语）
- "少羽牛逼" → 放行（赞美/网络用语，不是人身攻击）
- "牛逼" → 放行（网络用语，意思是"厉害"，不是骂人）
- "推荐一个好用的工具：https://xxx.com" → 放行（分享资源，不是广告）
- "加我微信xxxx，赚钱项目" → 拦截（刷屏营销广告）
- "想被大调查了" → 拦截（"大调查"是"大屌插"的谐音，色情低俗）
- "孙笑川简直日本天皇级别" → 放行（玩梗、网络文化，非人身攻击）
- "孙笑川" → 放行（网络主播名字，不是违规词）
- 不确定 → 放行

【输出格式 - 重要：必须扫描全文，列出所有违规】
- 安全：{"status":"pass"}
- 违规（可能有多条）：{"status":"reject", "violations":[{"reason":"简短说明2-6字", "violation_phrase":"原样摘抄的具体违规词或短句"}, {"reason":"简短说明2-6字", "violation_phrase":"原样摘抄的具体违规词或短句"}]}
- reason：让 AI 用2-6个字简短概括违规原因，如"辱骂家人""政治敏感""色情内容""广告欺诈"等，不要用长句
- violation_phrase：必须原样复制用户帖子中的具体违规词语
- 如果有多处违规，violations 数组里放全部
- 只返回JSON，不要其他文字

【输出示例】
文本："你们的妈都死了，法西斯主义万岁"
输出：{"status":"reject", "violations":[{"reason":"辱骂家人", "violation_phrase":"你们的妈都死了"}, {"reason":"宣扬法西斯", "violation_phrase":"法西斯主义万岁"}]}`;

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

		// Call AI with judge system prompt — non-streaming since output is tiny JSON
		const result = await env.AI.run<typeof MODEL_ID>(MODEL_ID, {
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: content },
			],
			max_tokens: 50, // Only needs to output {"status":"pass"} — ~20 tokens
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
