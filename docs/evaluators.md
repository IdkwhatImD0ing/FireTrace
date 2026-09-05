# Scores and evaluators

A trace tells you what happened. A **score** tells you whether it was any good: a thumbs rating from your users, a verdict a reviewer entered on the trace page, or the answer of an **evaluator**, an LLM-as-a-judge prompt that FireTrace runs against the trace for you. Scores are indexed, listed per trace and per project, and summarized on every trace as the newest value per name.

## Scores

A score has a `name` (letters, digits, `_` and `-`; it doubles as the display name), a `dataType` of `numeric`, `categorical`, or `boolean` with a matching `value`, an optional `comment`, and a `source`:

| Source       | Written by                                                                            |
| ------------ | ------------------------------------------------------------------------------------- |
| `api`        | `POST /api/v1/traces/{traceId}/scores` ([api.md](./api.md#scores)) or MCP `add_score` |
| `annotation` | The Scores tab of a trace page in the dashboard                                       |
| `eval`       | An evaluator run; the score also carries `evaluatorId` and `runId`                    |

Scores are append-only. Adding a name again records a newer score; the trace's summary shows the newest per name and the trace page lists the whole history. A trace holds at most 100 scores. Deleting a score is explicit (dashboard, `DELETE /api/v1/traces/{traceId}/scores/{scoreId}`); deleting a trace deletes its scores.

The **Scores** page of a project (`/projects/<id>/scores`) lists recent scores newest first with a name and time-range filter and a per-name summary: the average for numeric scores, value counts for the others. The summary covers the scores shown on the page, not the whole history.

## Configure the judge endpoint

Evaluators call any OpenAI-compatible chat-completions endpoint. Set all three variables on the server (Vercel: Settings → Environment Variables; locally: `.env.local`):

| Variable                  | Example                        |
| ------------------------- | ------------------------------ |
| `FIRETRACE_EVAL_BASE_URL` | `https://api.openai.com/v1`    |
| `FIRETRACE_EVAL_API_KEY`  | the provider's key             |
| `FIRETRACE_EVAL_MODEL`    | `gpt-5-mini` (default per run) |

FireTrace posts to `<BASE_URL>/chat/completions` with the key as a bearer token and asks for JSON output. Base URLs that are known to work with this shape include OpenAI (`https://api.openai.com/v1`), Anthropic's compatibility endpoint (`https://api.anthropic.com/v1`), Google Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`), OpenRouter (`https://openrouter.ai/api/v1`), Vercel AI Gateway (`https://ai-gateway.vercel.sh/v1`), and a local Ollama (`http://localhost:11434/v1`). FireTrace first requests structured output (`response_format: json_schema`) and falls back to a plain request when the endpoint rejects it. Leave all three unset and the Evaluators page explains what is missing; definitions can still be created.

Only allowlisted owners can define and run evaluators, because a run spends this key. Trial accounts never see the controls.

## Define an evaluator

Open **Evaluators** from a project page. An evaluator has:

- **Name**: becomes the score name, so `correctness` produces scores called `correctness`.
- **Prompt**: free text with variables that are filled from the trace at run time:

  | Variable       | Value                                                                     |
  | -------------- | ------------------------------------------------------------------------- |
  | `{{input}}`    | the trace's `input` (strings as-is, JSON pretty-printed)                  |
  | `{{output}}`   | the trace's `output`                                                      |
  | `{{metadata}}` | the trace's `metadata`, or `(none)`                                       |
  | `{{name}}`     | the trace name                                                            |
  | `{{spans}}`    | an indented outline of the span tree: kind, name, status, duration, model |

  Each variable is cut at 20,000 characters with a marker. Unknown variables are left as written.

- **Score type**: `numeric` with a min and max, `categorical` with 2–20 choices, or `boolean`. The judge is told which shape to answer in and its answer is validated against it; an out-of-range number or an unknown label fails the run rather than writing a bad score.
- **Model** (optional): overrides `FIRETRACE_EVAL_MODEL` for this evaluator.

Seven templates are offered as starting points (correctness, answer relevance, groundedness, PII leakage, prompt injection, topic classification, user frustration). They are plain text you edit before saving; nothing runs on its own.

**Test before saving**: paste a trace id into the form and press Test. FireTrace renders the prompt from that trace, asks the judge, and shows the rendered prompt, the raw answer, and the parsed verdict. Nothing is written.

## Run an evaluator

- **One trace**: on a trace page, open the Scores tab, pick an evaluator, press Run. The verdict appears as a score with source `eval` and the judge's reasoning as its comment.
- **Many traces**: on the trace list, filter as usual, pick an evaluator in the bar under the filters, and press Run. The evaluator runs over the newest 50 traces matching the filters, four at a time, and reports how many were scored, skipped, or failed.

A trace that already carries a score from the same evaluator is **skipped** unless you tick re-run; forcing a re-run records an additional score and the newest one becomes the summary value.

Every attempt that reaches the judge is logged under **Recent runs** on the Evaluators page: time, evaluator, trace, trigger, status, model, tokens, duration, and the error for failed runs. Failed runs (endpoint down, non-JSON answer, value outside the score type) write no score.

## What is sent where

A run sends the rendered prompt, and therefore the trace's input, output, metadata, and span names, to the configured endpoint. Do not point a project at a judge you would not trust with its traces. The provider's response is stored only as the score value and comment plus token counts; prompts and completions are never logged by FireTrace ([security.md](./security.md)).

## Limits and non-goals

- 50 traces per bulk run, 4 concurrent judge calls, 60 s timeout per call with one retry on transient errors.
- One evaluator per run; run it again for another evaluator.
- Evaluators run only when you press Run. Automatic evaluation of incoming traces (rules with sampling) is a planned follow-up; the run log already records a `trigger` so it can be added without a migration.
- Evaluators cannot execute your own code; a judgement is always an LLM answer or a score you send through the API.
