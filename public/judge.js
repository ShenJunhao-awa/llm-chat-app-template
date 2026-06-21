/**
 * AI Judge Frontend
 *
 * A simple interface to test the content moderation API.
 * The actual integration happens in the forum's CreatePost page.
 */

// DOM elements
const judgeInput = document.getElementById("judge-input");
const judgeButton = document.getElementById("judge-button");
const judgeStatus = document.getElementById("judge-status");
const judgeResult = document.getElementById("judge-result");
const judgeOutput = document.getElementById("judge-output");
const judgeBadgePass = document.getElementById("judge-badge-pass");
const judgeBadgeReject = document.getElementById("judge-badge-reject");
const judgeLoading = document.getElementById("judge-loading");
const judgeError = document.getElementById("judge-error");

// Judges a piece of text via the API
async function judgeText() {
  const text = judgeInput.value.trim();

  if (text === "") {
    judgeError.textContent = "请输入要审核的文本";
    judgeError.classList.remove("hidden");
    return;
  }

  // Show loading state
  judgeButton.disabled = true;
  judgeLoading.classList.remove("hidden");
  judgeStatus.classList.add("hidden");
  judgeError.classList.add("hidden");
  judgeResult.classList.add("hidden");

  try {
    const response = await fetch("/api/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });

    const data = await response.json();

    // Show result
    judgeResult.classList.remove("hidden");
    judgeLoading.classList.add("hidden");

    if (data.status === "pass") {
      judgeBadgePass.classList.remove("hidden");
      judgeBadgeReject.classList.add("hidden");
      judgeOutput.textContent = "✅ 内容合规，审核通过";
      judgeOutput.className = "text-green-700 font-medium";
    } else if (data.status === "reject") {
      judgeBadgePass.classList.add("hidden");
      judgeBadgeReject.classList.remove("hidden");
      judgeOutput.textContent = "❌ 内容违规，审核未通过";
      judgeOutput.className = "text-red-700 font-medium";
    } else {
      judgeOutput.textContent = "⚠️ 审核结果异常：" + (data.error || "未知状态");
      judgeOutput.className = "text-yellow-700 font-medium";
    }

    // Show raw API response
    document.getElementById("judge-raw-response").textContent =
      JSON.stringify(data, null, 2);
  } catch (err) {
    judgeLoading.classList.add("hidden");
    judgeError.textContent = "请求失败：" + err.message;
    judgeError.classList.remove("hidden");
  } finally {
    judgeButton.disabled = false;
  }
}

// Event listeners
judgeButton.addEventListener("click", judgeText);

// Ctrl+Enter shortcut
judgeInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    judgeText();
  }
});
