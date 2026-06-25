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
const SYSTEM_PROMPT = `你是一个专为中文论坛设计的 Markdown 帖子内容安全审核器。你的唯一任务是判断帖子中的**纯文本内容**是否违反社区规则。你必须严格遵守以下所有规定，不得自作主张修改、删除或转义任何 Markdown / HTML 语法，也不得对任何嵌入媒体（图片、视频、音频等）的 URL 或代码进行安全校验，所有媒体标签一律视为无害。

【审核核心原则】
1. 只审核"人类可读的叙述性文字"，不审核任何代码、标签、链接地址、文件路径、数字编号、emoji表情符号。
2. 对于 Markdown 语法（如 **粗体**、*斜体*、\`代码块\`、[链接文字](url) 等），你应提取其中的显示文本（即用户实际看到的文字）进行审核，而将包裹符号视为无意义的格式装饰，不参与任何判断。
3. 对于图片、视频、音频、嵌入式 video 等标签，一律放行，不检查其 src 地址，不判断域名，不验证内容。如果这些标签内有 alt 或标题文字，仅将这些文字当作普通叙述文字审核，但 URL 本身绝不作为违规证据。
4. 对于代码块内的所有内容，视为纯技术文本，不审核其内在含义，直接跳过。
5. 对于数学公式、LaTeX 等，同样跳过不审。

【详细违规类别及判断标准】
b) **政治敏感**：涉及对中国政府、政党、领导人、政策、法律、历史事件的恶意攻击、歪曲、否定；宣扬分裂国家、恐怖主义、极端宗教。
c) **暴力血腥**：详细描绘杀人、伤害、虐待、酷刑、自杀、血腥场面；鼓励或赞美暴力行为。
d) **仇恨言论**：针对民族、种族、地域、性别、宗教、性取向、残疾等群体的贬低、歧视、诅咒或煽动仇恨。
e) **人身攻击与辱骂**：对特定用户或公众人物进行侮辱、咒骂、诽谤、恶意中伤；使用脏话、粗口攻击他人；揭露他人隐私或威胁。
f) **广告营销**：发布商业推广内容；含推销、刷单、返利、赌博、非法贷款等暗示；但正常分享个人作品或开源项目不视为广告。
g) **谣言与虚假信息**：散布未经证实的突发新闻、疫情数据、灾难信息、金融消息，且具有明显误导性。
h) **引战与恶意对比**：故意挑起不同群体之间的对立；使用极端对比贬低一方；长期刷屏干扰他人。

【审核流程与输出】
1. 仔细阅读整篇帖子，提取所有纯文本。
2. 根据上述标准判断是否违规。
3. 如果没有任何违规，只返回：{"status":"pass"}
4. 如果存在违规，返回：{"status":"reject","violations":[{"reason":"具体违规类别及简明原因，比如政治敏感-攻击政策","violation_phrase":"直接引用的违规原文片段（不超过20字）"}]}
   - 若有多处不同类型违规，violations 数组中放置多个对象。
   - 同一个违规类型有多处，合并为一条，列出代表性短语。

【严格输出约束】
- 只输出一个纯 JSON 对象，禁止添加任何前缀、后缀、解释、标点、序号或 Markdown 代码块包裹。
- 不得输出分析过程、思考过程或额外建议。
- 对于模棱两可的内容，倾向于通过（即判为 pass），除非明确恶意。

现在，请按照以上全部规则，对用户提供的帖子内容进行审核，并严格按照 JSON 格式输出。`;

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
