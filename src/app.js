const STORAGE_KEY = "classcheck-ai-v1";

const seedState = {
  view: "teacher",
  activeStudent: null,
  session: {
    code: "MATH-2147",
    title: "Exit Ticket",
    open: true,
  },
  questions: [
    {
      id: crypto.randomUUID(),
      prompt: "Explain why dividing by zero is undefined.",
      answerKey:
        "A strong answer says division asks how many groups of the divisor fit into the dividend, and zero groups cannot produce a nonzero amount. It should mention that no number multiplied by zero equals a nonzero dividend.",
      rubric:
        "Look for: division as inverse of multiplication; no number times zero can equal a nonzero number; distinguishes zero divided by nonzero from division by zero.",
      maxPoints: 4,
      open: true,
      createdAt: Date.now(),
    },
  ],
  submissions: [],
};

let state = loadState();
const app = document.querySelector("#app");
const pendingGrades = new Set();
let openAIConfig = { enabled: false, source: "unknown", model: "gpt-4o-mini" };

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState;
  try {
    return { ...seedState, ...JSON.parse(raw) };
  } catch {
    return seedState;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setState(patch) {
  state = { ...state, ...patch };
  saveState();
  render();
}

function updateSession(patch) {
  state.session = { ...state.session, ...patch };
  saveState();
  render();
}

async function refreshOpenAIConfig() {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    const response = await fetch("/api/openai-config", { signal: controller.signal });
    window.clearTimeout(timeout);
    openAIConfig = await response.json();
  } catch {
    openAIConfig = { enabled: false, source: "unavailable", model: "unknown" };
  }
}

async function saveOpenAIKey(event) {
  event.preventDefault();
  const apiKey = byId("openAIKey").value.trim();
  const status = byId("openAIStatusMessage");
  const submitButton = event.submitter;
  if (!apiKey) {
    status.textContent = "Paste an API key first.";
    return;
  }

  status.textContent = "Checking key...";
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch("/api/openai-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const result = await response.json();
    if (!response.ok) {
      status.textContent = result.error || "Could not save API key.";
      return;
    }
    openAIConfig = result;
    byId("openAIKey").value = "";
    render();
  } catch {
    status.textContent = "The local server is not responding. Restart it with node server.js.";
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

async function clearOpenAIKey() {
  try {
    const response = await fetch("/api/openai-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    openAIConfig = await response.json();
    render();
  } catch {
    const status = byId("openAIStatusMessage");
    if (status) status.textContent = "The local server is not responding. Restart it with node server.js.";
  }
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderRichText(value) {
  const paragraphs = escapeHtml(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replaceAll("\n", "<br>"))
    .join("</p><p>");
  return `<div class="math-content"><p>${paragraphs}</p></div>`;
}

function typesetMath(root = document.body, attempt = 0) {
  if (!window.renderMathInElement) {
    if (attempt < 20) {
      window.setTimeout(() => typesetMath(root, attempt + 1), 100);
    } else {
      root.querySelectorAll(".math-render-status").forEach((item) => item.remove());
      const status = document.createElement("p");
      status.className = "small math-render-status";
      status.textContent = "Math renderer did not load. Check internet access to cdn.jsdelivr.net.";
      root.append(status);
    }
    return;
  }
  root.querySelectorAll(".math-render-status").forEach((item) => item.remove());
  window.renderMathInElement(root, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function words(value) {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "been",
  "being",
  "from",
  "have",
  "into",
  "more",
  "must",
  "that",
  "their",
  "then",
  "there",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

function gradeResponse(question, response) {
  const responseWords = new Set(words(response));
  const expectedTerms = [...new Set([...words(question.answerKey), ...words(question.rubric)])].slice(0, 18);
  const matched = expectedTerms.filter((term) => responseWords.has(term));
  const coverage = expectedTerms.length ? matched.length / expectedTerms.length : 0;
  const lengthScore = Math.min(words(response).length / 35, 1);
  const rawScore = Math.round(question.maxPoints * (coverage * 0.75 + lengthScore * 0.25));
  const score = Math.max(response.trim().length ? 1 : 0, Math.min(question.maxPoints, rawScore));
  const missing = expectedTerms.filter((term) => !responseWords.has(term)).slice(0, 5);

  const feedbackParts = [];
  if (score >= question.maxPoints * 0.85) feedbackParts.push("Strong response with the main expected ideas present.");
  else if (score >= question.maxPoints * 0.55) feedbackParts.push("Partial response; several expected ideas are present.");
  else feedbackParts.push("Needs revision; key ideas from the rubric are missing or unclear.");

  if (missing.length) feedbackParts.push(`Missing or weak concepts: ${missing.join(", ")}.`);
  if (words(response).length < 18) feedbackParts.push("The response is short, so the reasoning may need more explanation.");

  return {
    score,
    matched,
    missing,
    feedback: feedbackParts.join(" "),
    gradedAt: Date.now(),
  };
}

function addQuestion(event) {
  event.preventDefault();
  const prompt = byId("prompt").value.trim();
  const answerKey = byId("answerKey").value.trim();
  const rubric = byId("rubric").value.trim();
  const maxPoints = Number(byId("maxPoints").value || 4);
  if (!prompt || !answerKey || !rubric) return;

  state.questions.unshift({
    id: crypto.randomUUID(),
    prompt,
    answerKey,
    rubric,
    maxPoints,
    open: true,
    createdAt: Date.now(),
  });
  saveState();
  render();
}

async function gradeWithServer(question, response) {
  const apiResponse = await fetch("/api/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, response }),
  });
  const result = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(result.error || "Unable to grade response.");
  return result.grade;
}

async function submitAnswer(event, questionId) {
  event.preventDefault();
  const response = byId(`response-${questionId}`).value.trim();
  if (!response || !state.activeStudent) return;

  const question = state.questions.find((item) => item.id === questionId);
  const existingIndex = state.submissions.findIndex(
    (item) => item.questionId === questionId && item.studentId === state.activeStudent.id,
  );
  const pendingKey = `${questionId}:${state.activeStudent.id}`;
  pendingGrades.add(pendingKey);
  render();

  try {
    const grade = await gradeWithServer(question, response);
    const submission = {
      id: existingIndex >= 0 ? state.submissions[existingIndex].id : crypto.randomUUID(),
      questionId,
      studentId: state.activeStudent.id,
      response,
      grade,
      submittedAt: Date.now(),
    };

    if (existingIndex >= 0) state.submissions[existingIndex] = submission;
    else state.submissions.push(submission);

    saveState();
  } catch (error) {
    alert(error.message);
  } finally {
    pendingGrades.delete(pendingKey);
    render();
  }
}

function loginStudent(event) {
  event.preventDefault();
  const code = byId("studentCode").value.trim().toUpperCase();
  const id = byId("studentId").value.trim();
  if (code !== state.session.code.toUpperCase() || !id) {
    byId("loginError").textContent = "Check the class code and student ID.";
    return;
  }
  setState({ activeStudent: { id } });
}

function questionAverage(questionId) {
  const question = state.questions.find((item) => item.id === questionId);
  const submissions = state.submissions.filter((item) => item.questionId === questionId);
  if (!submissions.length) return 0;
  return (
    submissions.reduce((sum, item) => sum + item.grade.score / question.maxPoints, 0) /
    submissions.length
  );
}

function commonErrors(questionId) {
  const counts = new Map();
  state.submissions
    .filter((item) => item.questionId === questionId)
    .forEach((item) => {
      item.grade.missing.forEach((term) => counts.set(term, (counts.get(term) || 0) + 1));
    });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function exportReport() {
  const rows = [["session", "question", "student_id", "score", "max_points", "response", "feedback"]];
  state.submissions.forEach((submission) => {
    const question = state.questions.find((item) => item.id === submission.questionId);
    rows.push([
      state.session.code,
      question?.prompt || "",
      submission.studentId,
      submission.grade.score,
      question?.maxPoints || "",
      submission.response,
      submission.grade.feedback,
    ]);
  });
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.session.code}-report.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function resetDemo() {
  if (!confirm("Clear all questions, student logins, and submissions in this browser?")) return;
  state = structuredClone(seedState);
  saveState();
  render();
}

function renderShell(content) {
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <strong>ClassCheck AI</strong>
          <span>${escapeHtml(state.session.title)} · Code ${escapeHtml(state.session.code)}</span>
        </div>
        <nav class="nav" aria-label="App views">
          <button class="${state.view === "teacher" ? "active" : ""}" data-view="teacher">Teacher</button>
          <button class="${state.view === "student" ? "active" : ""}" data-view="student">Student</button>
        </nav>
      </header>
      <main class="main">${content}</main>
    </div>
  `;

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setState({ view: button.dataset.view }));
  });
  typesetMath(app);
}

function renderTeacher() {
  const totalStudents = new Set(state.submissions.map((item) => item.studentId)).size;
  const totalSubmissions = state.submissions.length;
  const avgPercent = totalSubmissions
    ? Math.round(
        (state.submissions.reduce((sum, item) => {
          const question = state.questions.find((q) => q.id === item.questionId);
          return sum + item.grade.score / (question?.maxPoints || 1);
        }, 0) /
          totalSubmissions) *
          100,
      )
    : 0;

  renderShell(`
    <section class="band grid">
      <div class="row spread">
        <div>
          <h1>${escapeHtml(state.session.title)}</h1>
          <p class="small">Share this code with students: <strong>${escapeHtml(state.session.code)}</strong></p>
        </div>
        <div class="row">
          <button class="secondary" id="exportReport">Export CSV</button>
          <button class="danger" id="resetDemo">Reset</button>
        </div>
      </div>
      <div class="grid three">
        <div class="metric"><span class="small">Students</span><strong>${totalStudents}</strong></div>
        <div class="metric"><span class="small">Submissions</span><strong>${totalSubmissions}</strong></div>
        <div class="metric"><span class="small">Class Average</span><strong>${avgPercent}%</strong></div>
      </div>
    </section>

    <section class="grid two">
      <form class="band grid" id="sessionForm">
        <h2>Session Settings</h2>
        <label>Activity name<input id="sessionTitle" value="${escapeHtml(state.session.title)}" /></label>
        <label>Login code<input id="sessionCode" value="${escapeHtml(state.session.code)}" /></label>
        <div class="footer-actions">
          <button type="submit">Update</button>
        </div>
      </form>

      <form class="band grid" id="openAIForm">
        <div class="row spread">
          <h2>OpenAI Grading</h2>
          <span class="pill ${openAIConfig.enabled ? "open" : "closed"}">${openAIConfig.enabled ? "LLM On" : "Local Only"}</span>
        </div>
        <p class="small">
          ${openAIConfig.enabled
            ? `Using ${escapeHtml(openAIConfig.model)} from ${escapeHtml(openAIConfig.source)} configuration.`
            : "Paste an OpenAI API key to enable semantic grading for new submissions."}
        </p>
        <label>API key<input id="openAIKey" type="password" autocomplete="off" placeholder="sk-..." /></label>
        <p class="small" id="openAIStatusMessage">The key is kept in server memory and is not saved in localStorage.</p>
        <div class="footer-actions">
          <button type="button" class="secondary" id="clearOpenAIKey">Clear</button>
          <button type="submit">Use Key</button>
        </div>
      </form>

      <form class="band grid" id="questionForm">
        <h2>Post Question</h2>
        <label>Question prompt<textarea id="prompt" placeholder="Use LaTeX like \\(x^2\\) or \\[\\int_0^1 x^2\\,dx\\]"></textarea></label>
        <div class="preview-box">
          <span class="small">Student preview</span>
          <div id="questionPreview" class="math-content preview-content">Type a question to preview math.</div>
        </div>
        <label>Ideal answer<textarea id="answerKey" placeholder="What should a correct answer include? LaTeX is supported here too."></textarea></label>
        <label>Rubric / grading notes<textarea id="rubric" placeholder="List concepts, misconceptions, partial-credit rules, and criteria."></textarea></label>
        <label>Max points<input id="maxPoints" type="number" min="1" max="20" value="4" /></label>
        <div class="footer-actions">
          <button type="submit">Post Question</button>
        </div>
      </form>
    </section>

    <section class="band grid">
      <div class="row spread">
        <h2>Questions & Report</h2>
        <span class="small">LLM grading runs through the local server when OPENAI_API_KEY is set.</span>
      </div>
      ${state.questions.length ? state.questions.map(renderTeacherQuestion).join("") : `<div class="empty">No questions yet.</div>`}
    </section>
  `);

  byId("exportReport").addEventListener("click", exportReport);
  byId("resetDemo").addEventListener("click", resetDemo);
  byId("sessionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    updateSession({
      title: byId("sessionTitle").value.trim() || "Class Session",
      code: byId("sessionCode").value.trim().toUpperCase() || "CLASS-100",
    });
  });
  byId("questionForm").addEventListener("submit", addQuestion);
  byId("openAIForm").addEventListener("submit", saveOpenAIKey);
  byId("clearOpenAIKey").addEventListener("click", clearOpenAIKey);
  byId("prompt").addEventListener("input", () => updateQuestionPreview());
  updateQuestionPreview();
  document.querySelectorAll("[data-toggle-question]").forEach((button) => {
    button.addEventListener("click", () => {
      const question = state.questions.find((item) => item.id === button.dataset.toggleQuestion);
      question.open = !question.open;
      saveState();
      render();
    });
  });
}

function updateQuestionPreview() {
  const preview = byId("questionPreview");
  if (!preview) return;
  const value = byId("prompt").value.trim();
  preview.innerHTML = value ? renderRichText(value) : "Type a question to preview math.";
  typesetMath(preview);
}

function renderTeacherQuestion(question) {
  const submissions = state.submissions.filter((item) => item.questionId === question.id);
  const average = Math.round(questionAverage(question.id) * 100);
  const errors = commonErrors(question.id);
  return `
    <article class="question">
      <div class="question-title">
        <div class="grid">
          ${renderRichText(question.prompt)}
          <p class="small">${submissions.length} submission${submissions.length === 1 ? "" : "s"} · Average ${average}%</p>
        </div>
        <div class="row">
          <span class="pill ${question.open ? "open" : "closed"}">${question.open ? "Open" : "Closed"}</span>
          <button class="secondary" data-toggle-question="${question.id}">${question.open ? "Close" : "Reopen"}</button>
        </div>
      </div>
      <div class="report-list">
        <strong>Common missing ideas</strong>
        <div class="row">
          ${
            errors.length
              ? errors.map(([term, count]) => `<span class="error-chip"><b>${count}</b>${escapeHtml(term)}</span>`).join("")
              : `<span class="small">No graded responses yet.</span>`
          }
        </div>
      </div>
      <div class="grid">
        ${submissions.map((submission) => renderSubmission(submission, question)).join("") || `<div class="empty">Waiting for student responses.</div>`}
      </div>
    </article>
  `;
}

function renderSubmission(submission, question) {
  return `
    <div class="submission">
      <div class="row spread">
        <strong>${escapeHtml(submission.studentId)}</strong>
        <span class="pill score">${submission.grade.score}/${question.maxPoints}${submission.grade.provider === "openai" ? " · LLM" : " · Local"}</span>
      </div>
      ${renderRichText(submission.response)}
      <p class="small">${escapeHtml(submission.grade.feedback)}</p>
      ${
        submission.grade.misconceptions?.length
          ? `<p class="small"><strong>Misconceptions:</strong> ${escapeHtml(submission.grade.misconceptions.join(", "))}</p>`
          : ""
      }
    </div>
  `;
}

function renderStudent() {
  if (!state.activeStudent) {
    renderShell(`
      <section class="band grid">
        <h1>Student Login</h1>
        <form class="grid" id="studentLogin">
          <label>Class code<input id="studentCode" autocomplete="off" placeholder="MATH-2147" /></label>
          <label>Student ID<input id="studentId" autocomplete="off" placeholder="Your school ID" /></label>
          <p class="small" id="loginError"></p>
          <div class="footer-actions">
            <button type="submit">Enter</button>
          </div>
        </form>
      </section>
    `);
    byId("studentLogin").addEventListener("submit", loginStudent);
    return;
  }

  const openQuestions = state.questions.filter((question) => question.open);
  renderShell(`
    <section class="band row spread">
      <div>
        <h1>${escapeHtml(state.session.title)}</h1>
        <p class="small">Logged in as <strong>${escapeHtml(state.activeStudent.id)}</strong></p>
      </div>
      <button class="secondary" id="logoutStudent">Switch Student</button>
    </section>
    <section class="grid">
      ${
        openQuestions.length
          ? openQuestions.map(renderStudentQuestion).join("")
          : `<div class="band empty">No open questions right now.</div>`
      }
    </section>
  `);

  byId("logoutStudent").addEventListener("click", () => setState({ activeStudent: null }));
  openQuestions.forEach((question) => {
    byId(`answer-form-${question.id}`).addEventListener("submit", (event) => submitAnswer(event, question.id));
    byId(`response-${question.id}`).addEventListener("input", () => updateResponsePreview(question.id));
    updateResponsePreview(question.id);
  });
}

function updateResponsePreview(questionId) {
  const preview = byId(`response-preview-${questionId}`);
  const textarea = byId(`response-${questionId}`);
  if (!preview || !textarea) return;
  const value = textarea.value.trim();
  preview.innerHTML = value ? renderRichText(value) : "Type an answer to preview math.";
  typesetMath(preview);
}

function renderStudentQuestion(question) {
  const prior = state.submissions.find(
    (item) => item.questionId === question.id && item.studentId === state.activeStudent.id,
  );
  const pendingKey = `${question.id}:${state.activeStudent.id}`;
  const isPending = pendingGrades.has(pendingKey);
  return `
    <form class="band grid" id="answer-form-${question.id}">
      <div class="row spread">
        <div class="grid">
          <h2>Question</h2>
          ${renderRichText(question.prompt)}
        </div>
        ${prior ? `<span class="pill score">Last score ${prior.grade.score}/${question.maxPoints}</span>` : ""}
      </div>
      <label>Your response<textarea id="response-${question.id}" placeholder="Type your answer here.">${escapeHtml(prior?.response || "")}</textarea></label>
      <div class="preview-box">
        <span class="small">Answer preview</span>
        <div id="response-preview-${question.id}" class="math-content preview-content">Type an answer to preview math.</div>
      </div>
      ${prior ? `<div class="notice">${escapeHtml(prior.grade.feedback)}</div>` : ""}
      <div class="footer-actions">
        <button type="submit" ${isPending ? "disabled" : ""}>${isPending ? "Grading..." : prior ? "Update Answer" : "Submit Answer"}</button>
      </div>
    </form>
  `;
}

async function init() {
  render();
  await refreshOpenAIConfig();
  render();
}

function render() {
  if (state.view === "teacher") renderTeacher();
  else renderStudent();
}

init();
window.addEventListener("load", () => typesetMath(app));
