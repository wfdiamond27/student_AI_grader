# ClassCheck AI

A prototype for classroom short-answer collection, LaTeX-quality math prompts, and LLM-assisted grading.

## Run it

Start the local server:

```bash
node server.js
```

Then open `http://127.0.0.1:5174`.

For LLM grading, set an OpenAI API key before starting the server:

```bash
OPENAI_API_KEY=your_key_here node server.js
```

Without `OPENAI_API_KEY`, the app still runs but falls back to a lightweight local grader. It handles direct numeric or exact answers, but OpenAI grading is still the better path for explanations and partial credit.

You can also paste an API key in the Teacher view under **OpenAI Grading**. That key is sent to the local server and kept in server memory only. It is not stored in browser `localStorage`, and it will be cleared when the server restarts unless you started the server with `OPENAI_API_KEY`.

## What works now

- Teacher sets a class login code.
- Students enter the code plus their student ID.
- Teacher posts short-answer questions with an answer key and rubric.
- Teacher prompts, answer keys, rubrics, and student answers can include LaTeX.
- Students see rendered math in questions and can preview rendered math in their answers.
- The browser sends grading requests to the local server.
- The server uses OpenAI structured JSON grading when `OPENAI_API_KEY` is configured.
- The Teacher view can configure or clear the OpenAI key for the running local server.
- Teacher gets class average, per-question averages, common missing ideas, per-student feedback, and CSV export.

## Important prototype limit

This version still stores class data in the browser with `localStorage`. That is useful for trying the workflow, but it is not a real multi-device classroom deployment. For production, add:

- Backend database for sessions, questions, students, and submissions.
- Teacher authentication.
- Student roster or allowed-ID validation.
- Server-side AI grading with persistent grade records.
- Audit logs and FERPA-conscious data handling.

## LaTeX examples

Inline math:

```text
Differentiate \(f(x)=x^3-4x\).
```

Display math:

```text
Evaluate:

\[
\int_0^1 x^2\,dx
\]
```

## Suggested production stack

- Frontend: React or Next.js.
- Backend: Next.js API routes, Express, FastAPI, or Supabase Edge Functions.
- Database: Supabase/Postgres.
- AI grading: server-side rubric prompt that returns structured JSON: score, confidence, feedback, missing concepts, and misconception tags.
