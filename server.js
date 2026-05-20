const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
let runtimeOpenAIKey = process.env.OPENAI_API_KEY || "";

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const gradeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "confidence", "feedback", "missing", "misconceptions", "strengths", "summaryTag"],
  properties: {
    score: { type: "number" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    feedback: { type: "string" },
    missing: { type: "array", items: { type: "string" } },
    misconceptions: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    summaryTag: { type: "string" },
  },
};

function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        request.destroy();
        reject(new Error("Request too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function clampScore(score, maxPoints) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return 0;
  return Math.max(0, Math.min(maxPoints, Math.round(numericScore * 10) / 10));
}

function fallbackGrade(question, response) {
  const normalize = (value) =>
    String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const stopWords = new Set(["about", "after", "also", "because", "being", "from", "have", "into", "that", "their", "there", "this", "which", "with", "would"]);
  const words = (value) => normalize(value).split(" ").filter((word) => word.length > 3 && !stopWords.has(word));
  const responseWords = new Set(words(response));
  const expectedTerms = [...new Set([...words(question.answerKey), ...words(question.rubric)])].slice(0, 18);
  const matched = expectedTerms.filter((term) => responseWords.has(term));
  const missing = expectedTerms.filter((term) => !responseWords.has(term)).slice(0, 5);
  const coverage = expectedTerms.length ? matched.length / expectedTerms.length : 0;
  const lengthScore = Math.min(words(response).length / 35, 1);
  const score = response.trim().length
    ? Math.max(1, Math.round(question.maxPoints * (coverage * 0.75 + lengthScore * 0.25)))
    : 0;

  return {
    score: clampScore(score, question.maxPoints),
    confidence: 0.35,
    feedback:
      "Local fallback grade used because no OpenAI API key is configured. This is still keyword-oriented; set OPENAI_API_KEY for semantic grading.",
    missing,
    misconceptions: [],
    strengths: matched.slice(0, 5),
    summaryTag: "fallback",
    provider: "local",
    gradedAt: Date.now(),
  };
}

async function gradeWithOpenAI(question, studentResponse) {
  if (!runtimeOpenAIKey) {
    return fallbackGrade(question, studentResponse);
  }

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${runtimeOpenAIKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions:
        "You are a careful professor grading short-answer math and STEM responses. Grade semantic understanding, not keyword overlap. Accept equivalent reasoning and notation. Be concise, fair, and calibrated to the provided rubric. Return only JSON that matches the schema.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task: "Grade this student answer.",
                maxPoints: question.maxPoints,
                questionPrompt: question.prompt,
                idealAnswer: question.answerKey,
                rubric: question.rubric,
                studentResponse,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "short_answer_grade",
          strict: true,
          schema: gradeSchema,
        },
      },
    }),
  });

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();
    throw new Error(`OpenAI API error ${apiResponse.status}: ${errorText}`);
  }

  const result = await apiResponse.json();
  const outputText =
    result.output_text ||
    result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI response did not include output text.");

  const grade = JSON.parse(outputText);
  return {
    ...grade,
    score: clampScore(grade.score, question.maxPoints),
    missing: grade.missing.slice(0, 8),
    misconceptions: grade.misconceptions.slice(0, 8),
    strengths: grade.strengths.slice(0, 8),
    provider: "openai",
    model: MODEL,
    gradedAt: Date.now(),
  };
}

async function handleGrade(request, response) {
  try {
    const body = JSON.parse(await readBody(request));
    if (!body?.question || typeof body.response !== "string") {
      sendJson(response, 400, { error: "Expected question and response." });
      return;
    }
    const question = {
      prompt: String(body.question.prompt || ""),
      answerKey: String(body.question.answerKey || ""),
      rubric: String(body.question.rubric || ""),
      maxPoints: Number(body.question.maxPoints || 4),
    };
    const grade = await gradeWithOpenAI(question, body.response);
    sendJson(response, 200, { grade });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

function openAIStatus() {
  return {
    enabled: Boolean(runtimeOpenAIKey),
    source: runtimeOpenAIKey
      ? process.env.OPENAI_API_KEY && runtimeOpenAIKey === process.env.OPENAI_API_KEY
        ? "environment"
        : "teacher"
      : "none",
    model: MODEL,
  };
}

async function handleOpenAIConfig(request, response) {
  try {
    if (request.method === "GET") {
      sendJson(response, 200, openAIStatus());
      return;
    }

    const rawBody = await readBody(request);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const apiKey = String(body.apiKey || "").trim();
    if (body.clear) {
      runtimeOpenAIKey = process.env.OPENAI_API_KEY || "";
      sendJson(response, 200, openAIStatus());
      return;
    }
    if (!apiKey.startsWith("sk-")) {
      sendJson(response, 400, { error: "Paste a valid OpenAI API key that starts with sk-." });
      return;
    }
    runtimeOpenAIKey = apiKey;
    sendJson(response, 200, openAIStatus());
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

function serveStatic(request, response) {
  const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
  const requestPath = parsedUrl.pathname === "/" ? "/index.html" : decodeURIComponent(parsedUrl.pathname);
  const filePath = path.normalize(path.join(ROOT, requestPath));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/grade") {
    handleGrade(request, response);
    return;
  }
  if ((request.method === "GET" || request.method === "POST") && request.url === "/api/openai-config") {
    handleOpenAIConfig(request, response);
    return;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response);
    return;
  }
  response.writeHead(405);
  response.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`ClassCheck AI running at http://127.0.0.1:${PORT}`);
  console.log(runtimeOpenAIKey ? `LLM grading enabled with ${MODEL}.` : "Set OPENAI_API_KEY or configure a key in Teacher view to enable LLM grading.");
});
