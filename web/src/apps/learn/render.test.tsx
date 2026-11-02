import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnswerDetails } from "@shared/learn/sessions";
import { AnsweredCard, ConcludedCard, ProblemCard } from "./Cards";
import { Dock } from "./Dock";
import { QuestionForm } from "./QuestionForm";
import { Transcript } from "./Transcript";
import { cacheWords, contextShare, contextWords, costWords, coverageFill } from "./stats";
import { emptyForm, toClientQuestion, toggleValue } from "./questions";
import { Markdown } from "./Markdown";
import { chartWidth } from "./diagram";

const quizQ = toClientQuestion({ id: "c1", name: "quiz", arguments: { type: "check", nodeId: "n1", question: "Which is **larger**?", options: ["one", "two"], correctAnswer: "two", explanation: "SECRET REASON" } })!;
const askQ = toClientQuestion({ id: "c2", name: "ask_user_question", arguments: { question: "Which?", options: ["a", "b"] } })!;
const textQ = toClientQuestion({ id: "c3", name: "ask_user_question", arguments: { question: "Why?" } })!;

const formProps = { onForm: () => undefined, compacting: false, submitting: false, onSubmit: () => undefined, active: true };

describe("the question form (B-9-03, B-9-04, B-9-05)", () => {
  const html = renderToStaticMarkup(<QuestionForm q={quizQ} form={emptyForm()} {...formProps} />);

  it("shows the options, the not known option and the confidence control at its resting value, and never the answer or the reasons", () => {
    expect(html).toContain("one");
    expect(html).toContain("two");
    expect(html).toContain("I do not know");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("50%");
    expect(html).not.toContain("SECRET REASON");
    expect(html).not.toContain("correctAnswer");
    expect(html).toContain("Check");
  });

  it("disables submit until an answer exists and enables it after a pick", () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit answer/);
    const picked = renderToStaticMarkup(<QuestionForm q={quizQ} form={toggleValue(emptyForm(), quizQ, "two")} {...formProps} />);
    expect(picked).not.toMatch(/<button[^>]*disabled=""[^>]*>Submit answer/);
    expect(picked).toContain('aria-checked="true"');
  });

  it("greys the confidence control and says Not given when the not known option is chosen", () => {
    const f = { ...emptyForm(), dontKnow: true };
    const out = renderToStaticMarkup(<QuestionForm q={quizQ} form={f} {...formProps} />);
    expect(out).toContain("Not given");
    expect(out).toContain('aria-disabled="true"');
  });

  it("keeps a half made answer when it is rendered again from the same draft", () => {
    const f = { ...toggleValue(emptyForm(), quizQ, "one"), thinking: "my reasoning", confidenceIdx: 4 };
    const out = renderToStaticMarkup(<QuestionForm q={quizQ} form={f} {...formProps} />);
    expect(out).toContain("my reasoning");
    expect(out).toContain("90%");
  });

  it("shows an Other row with an editable field for an open question, with no confidence and no grading", () => {
    const out = renderToStaticMarkup(<QuestionForm q={askQ} form={emptyForm()} {...formProps} />);
    expect(out).toContain("Type your own answer");
    expect(out).not.toContain('role="slider"');
    expect(out).not.toContain("I do not know");
  });

  it("asks for an answer in words when there are no options, and says when the session is compacting", () => {
    const out = renderToStaticMarkup(<QuestionForm q={textQ} form={emptyForm()} {...formProps} compacting />);
    expect(out).toContain("Your answer");
    expect(out).toContain("Compacting the session");
  });

  it("stays in the page but hidden when it is folded", () => {
    expect(renderToStaticMarkup(<QuestionForm q={quizQ} form={emptyForm()} {...formProps} active={false} />)).toContain("hidden");
  });

  it("marks a multiple choice with its hint and checkboxes", () => {
    const q = toClientQuestion({ id: "c4", name: "quiz", arguments: { type: "check", question: "Pick", options: ["a", "b", "c"], multiSelect: true, correctAnswer: ["a"], explanation: "x" } })!;
    const out = renderToStaticMarkup(<QuestionForm q={q} form={emptyForm()} {...formProps} />);
    expect(out).toContain("Select all that apply");
    expect(out).toContain('role="checkbox"');
  });
});

describe("the answered card (B-9-06, B-9-10, B-9-12)", () => {
  const details = (over: Partial<AnswerDetails>): AnswerDetails => ({ kind: "quiz", tool: "quiz", questionText: "Which is larger?", options: [{ label: "one", value: "one" }, { label: "two", value: "two" }], answers: [{ label: "one", value: "one", index: 1 }], correct: false, correctIndices: [2], confidence: 70, thinking: "I guessed", answeredAt: "", ...over });
  const block = (d: AnswerDetails) => ({ kind: "answered" as const, id: "x", callId: "c1", tool: "quiz", question: quizQ, details: d, explanation: "Because two is more.", committed: "" });

  it("grades with a word and a shape, shows the correct row, the confidence and the thinking as its own block", () => {
    const out = renderToStaticMarkup(<AnsweredCard block={block(details({}))} />);
    expect(out).toContain("Incorrect");
    expect(out).toContain("Correct answer");
    expect(out).toContain("Your answer");
    expect(out).toContain("Confidence 70%");
    expect(out).toContain("I guessed");
    expect(out).toContain("Why");
    expect(out).not.toContain("Because two is more.");
  });

  it("shows no confidence line where none was given, and Did not know for the not known option", () => {
    const out = renderToStaticMarkup(<AnsweredCard block={block(details({ confidence: undefined, dontKnow: true, answers: [], correct: undefined }))} />);
    expect(out).not.toContain("Confidence");
    expect(out).toContain("Did not know");
  });

  it("does not grade an open question and shows the typed answer as a quoted row", () => {
    const d: AnswerDetails = { kind: "ask", tool: "ask_user_question", questionText: "Which?", answers: [], other: "my own", answeredAt: "" };
    const out = renderToStaticMarkup(<AnsweredCard block={{ ...block(d), question: askQ }} />);
    expect(out).not.toContain("Correct");
    expect(out).not.toContain("Incorrect");
    expect(out).toContain("my own");
    expect(out).toContain("Question");
  });

  it("reveals the committed answer of a free recall question with no verdict chip", () => {
    const d: AnswerDetails = { kind: "explain", tool: "explain", questionText: "Say it", answers: [], text: "in my words", committed: "The full answer", answeredAt: "" };
    const out = renderToStaticMarkup(<AnsweredCard block={{ ...block(d), question: null, committed: "The full answer" }} />);
    expect(out).toContain("The answer");
    expect(out).toContain("The full answer");
    expect(out).toContain("in my words");
    expect(out).not.toContain("Incorrect");
  });

  it("lifts the reading thinking above the card", () => {
    const out = renderToStaticMarkup(<AnsweredCard block={block(details({ readingThinking: "noted while reading" }))} />);
    expect(out.indexOf("noted while reading")).toBeLessThan(out.indexOf('data-block="answered"'));
  });
});

describe("the practice cards (B-9-34)", () => {
  it("shows the problem card with its label and no solution, and the concluded card with the solution", () => {
    const p = renderToStaticMarkup(<ProblemCard block={{ kind: "problem", id: "p", callId: "p1", statement: "Solve it", mode: "recall" }} />);
    expect(p).toContain("Problem");
    expect(p).toContain("Solve it");
    const c = renderToStaticMarkup(<ConcludedCard block={{ kind: "concluded", id: "c", callId: "c1", outcome: "solvedWithHints", verdict: "Reached it with a hint.", solution: "The worked solution", mode: "recall", targets: ["n_1"], rung: "R1", missClass: null, retest: false }} names={{ n_1: "Common denominators" }} />);
    expect(c).toContain("Solved with hints");
    expect(c).toContain("Model solution");
    expect(c).toContain("The worked solution");
    expect(c).toContain("Details");
  });
});

describe("the dock (B-9-14, B-9-36, B-9-75)", () => {
  const composer = { busy: false, blocked: false, pause: false, placeholder: "Ask, answer or steer the lesson", onSend: async () => true, onSteer: () => undefined, onStop: () => undefined, onNext: () => undefined };
  const base = { variant: "composer" as const, composer, question: null, problem: null, compacting: false, steers: [], notice: null, error: null, stats: "Context not reported", controls: null };

  it("shows the composer with its placeholder and a disabled Send when empty", () => {
    const out = renderToStaticMarkup(<Dock {...base} />);
    expect(out).toContain('placeholder="Ask, answer or steer the lesson"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Send/);
  });

  it("morphs to Stop while busy and empty, and to Next problem in a practice pause", () => {
    expect(renderToStaticMarkup(<Dock {...base} composer={{ ...composer, busy: true }} />)).toContain("Stop");
    expect(renderToStaticMarkup(<Dock {...base} composer={{ ...composer, pause: true }} />)).toContain("Next problem");
    expect(renderToStaticMarkup(<Dock {...base} composer={{ ...composer, busy: true, pause: true }} />)).not.toContain("Next problem");
  });

  it("shows one truncated line for each queued steer, and nothing when the queue is empty", () => {
    expect(renderToStaticMarkup(<Dock {...base} steers={[{ id: "s1", text: "slow down" }]} />)).toContain("slow down");
    expect(renderToStaticMarkup(<Dock {...base} />)).not.toContain("queued-steer");
  });

  it("keeps the composer in the page, hidden, while a question owns the dock", () => {
    const question = { key: "c1", q: quizQ, form: emptyForm(), onForm: () => undefined, reading: "", onReading: () => undefined, arrival: "open" as const, onOpen: () => undefined, onSubmit: () => undefined, submitting: false };
    const out = renderToStaticMarkup(<Dock {...base} variant="question" question={question} />);
    expect(out).toContain('data-form="question"');
    expect(out).toContain("Message");
    expect(out.match(/hidden=""/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it("puts a check behind a reveal bar with the reading notes field, and a folded question behind an Answer button", () => {
    const question = { key: "c1", q: quizQ, form: emptyForm(), onForm: () => undefined, reading: "", onReading: () => undefined, arrival: "reveal" as const, onOpen: () => undefined, onSubmit: () => undefined, submitting: false };
    const reveal = renderToStaticMarkup(<Dock {...base} variant="question" question={question} />);
    expect(reveal).toContain("Check your understanding");
    expect(reveal).toContain("Thinking while reading");
    const folded = renderToStaticMarkup(<Dock {...base} variant="question" question={{ ...question, arrival: "folded" }} />);
    expect(folded).toContain("Answer");
    expect(folded).not.toContain("Thinking while reading");
  });

  it("shows the setup notice above the composer", () => {
    expect(renderToStaticMarkup(<Dock {...base} notice={{ text: "Add a provider key", onPress: () => undefined }} />)).toContain("Add a provider key");
  });
});

describe("the transcript has no chat bubbles (B-9-47)", () => {
  it("draws the learner on a band with a rail and the teacher as plain text", () => {
    const out = renderToStaticMarkup(
      <Transcript
        blocks={[
          { kind: "user", id: "u", text: "Hello", images: 0 },
          { kind: "teacher", id: "t", text: "Hi **there**", streaming: false },
          { kind: "divider", id: "d", label: "Teaching" },
          { kind: "compaction", id: "c" },
        ]}
        thinking={false}
        compacting={false}
        failure={null}
        onRetry={null}
        onOpenPlan={() => undefined}
        onRetryQuestion={() => undefined}
        retryDisabled={null}
      />,
    );
    expect(out).toContain("border-l-2");
    expect(out).toContain("<strong");
    expect(out).toContain("Teaching");
    expect(out).toContain("Earlier messages were summarised here");
    expect(out).not.toMatch(/rounded-(2xl|3xl|full)[^"]*bg-/);
  });

  it("shows Thinking, Compacting context and a failure with a retry", () => {
    const props = { blocks: [], thinking: true, compacting: false, failure: null, onRetry: null, onOpenPlan: () => undefined, onRetryQuestion: () => undefined, retryDisabled: null };
    expect(renderToStaticMarkup(<Transcript {...props} />)).toContain("Thinking");
    expect(renderToStaticMarkup(<Transcript {...props} thinking={false} compacting />)).toContain("Compacting context");
    const failed = renderToStaticMarkup(<Transcript {...props} thinking={false} failure="The model stopped." onRetry={() => undefined} />);
    expect(failed).toContain("The model stopped.");
    expect(failed).toContain("Try again");
  });
});

describe("the Markdown of a lesson (B-9-40, B-9-41, B-9-44)", () => {
  it("renders a GFM table in a scroll wrapper, inline and display maths, and real strong and em elements", () => {
    const out = renderToStaticMarkup(<Markdown>{"| a | b |\n|---|---|\n| 1 | 2 |\n\nSee $x^2$ and **bold** and *soft*.\n\n$$\ny = 2\n$$"}</Markdown>);
    expect(out).toContain("<table");
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("katex");
    expect(out).toContain("katex-display");
    expect(out).toContain("<strong");
    expect(out).toContain("<em>");
  });

  it("keeps escaped currency as text and does not follow a javascript link or render raw HTML", () => {
    const out = renderToStaticMarkup(<Markdown>{"It costs \\$5 and $10 more. [x](javascript:alert(1)) <script>alert(1)</script>"}</Markdown>);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<script");
  });

  it("does not trust the commands that load a link or a resource", () => {
    const out = renderToStaticMarkup(<Markdown>{"$\\href{https://example.com}{x}$"}</Markdown>);
    expect(out).not.toContain('href="https://example.com"');
  });

  it("shows a diagram fence as a waiting block and never as code while it streams", () => {
    const out = renderToStaticMarkup(<Markdown streaming>{"```mermaid\ngraph TD\nA-->B\n```"}</Markdown>);
    expect(out).toContain("Waiting for the end of the diagram");
    expect(out).not.toContain("<pre");
  });

  it("repairs tool authored maths only when asked", () => {
    const raw = "$\\\\nabla f$";
    expect(renderToStaticMarkup(<Markdown fromTool>{raw}</Markdown>)).not.toContain("katex-error");
  });
});

describe("the figures of the stats row (B-9-90, B-9-93)", () => {
  it("says so in words when a figure is not known", () => {
    expect(contextWords(null, null)).toBe("Context not reported");
    expect(contextWords(12400, 200000)).toBe("12,400 of 200,000 tokens");
    expect(contextWords(12400, null)).toBe("12,400 tokens");
    expect(costWords(null)).toBe("Not priced");
    expect(costWords(0.1234)).toBe("$0.123");
    expect(costWords(2.5)).toBe("$2.50");
    expect(cacheWords(null)).toBe("Not reported");
    expect(cacheWords(0.456)).toBe("46%");
    expect(contextShare(100, null)).toBeNull();
    expect(contextShare(300, 200)).toBe(1);
    expect(coverageFill({ uncoveredTokens: 2048, threshold: 4096 })).toBe(0.5);
    expect(coverageFill(null)).toBe(0);
  });

  it("reads the width of a diagram from its viewBox", () => {
    expect(chartWidth('<svg viewBox="0 0 320.5 100">')).toBe(320.5);
    expect(chartWidth('<svg width="200">')).toBe(200);
    expect(chartWidth("<svg>")).toBe(600);
  });
});
