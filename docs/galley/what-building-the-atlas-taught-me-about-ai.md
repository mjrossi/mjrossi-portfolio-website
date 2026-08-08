# Review notes — what-building-the-atlas-taught-me-about-ai

Pulled 2026-08-08T22:50:12.595Z from `production`.
51 open notes, 1 reviewer(s).

> Each note carries its id. `just galley-close what-building-the-atlas-taught-me-about-ai` closes exactly the ids in this file — notes filed after this pull are left open.

Source: `src/content/blog/what-building-the-atlas-taught-me-about-ai.mdx`

---

## Line 8-8

```md
This is the last of three posts about building [the Urbanist Atlas](https://urbanistatlas.com) with Claude Code. The first two covered [the code](/blog/i-used-ai-to-build-the-urbanist-atlas/) — the Go API and the React frontend — and then [the data](/blog/the-atlas-data-was-the-hard-part/), where mo…
```

**kw** · comment · 2026-08-08 · `df0d2986-dd69-49d2-9fcf-ce0851c9aeca`

> harder half

Context when written:

> …anizations turned out to be theharder half.…

> of what?

---

## Line 14-14

```md
More than once I stopped and asked whether this was actually saving me time. The loops are long, a lot of the day goes to waiting, and reviewing the same output for the fourth time is genuinely mind-numbing.
```

**kw** · comment · 2026-08-08 · `82f3a08e-1863-4cd2-a8c6-20c490bb9fdf`

> waiting

> waiting for what

**kw** · suggestion · 2026-08-08 · `3ac3b643-19bb-452d-a01a-8d83da7ddf2b`

> fourth

Suggested replacement:

```md
umpteenth?
```

---

## Line 16-16

```md
Some of that was the models and some of it was the workflow they create. There's an art and a craft to writing software, and that becomes harder to access when your day goes to reading generated code instead of writing your own. The code that comes back is functional and rarely better than that: som…
```

**kw** · comment · 2026-08-08 · `1b11ffe9-699e-46c8-a87c-f887943497c8`

> The code that comes back is functional and rarely better than that: something trained on a vast corpus of existing code tends toward the familiar, which isn’t the same as the right answer for your particular problem.

> really good line!

---

## Line 18-18

```md
Despite all the human review I built into the process, not writing the code myself made it hard to fully and accurately know what I was working with. When I write code, the act of writing it forces me to construct a mental model in real time. When AI writes it, I have to construct that mental model …
```

**kw** · comment · 2026-08-08 · `f1e93684-5fd2-4ef0-9049-bbda949c28f1`

> Despite all the human review I built into the process, not writing the code myself made it hard to fully and accurately know what I was working with. When I write code, the act of writing it forces me to construct a mental model in real time. When AI writes it, I have to construct that mental model through review. It feels analogous to handwriting vs. typing — handwriting is going to do a better job of committing something to memory.

> i really really like this too

---

## Line 20-20

```md
And the end result isn't the only thing that has to be right. I still had to flesh out the security parameters, and make the deploy strategy robust enough to survive an intermittent failure. I still had to decide how third-party libraries got imported and used, and how the abstractions across the ne…
```

**kw** · suggestion · 2026-08-08 · `b8f85042-6fa9-4acc-92bd-c1a9a122b686`

> demo that works

Suggested replacement:

```md
demo that's functional/baseline workable? "works" implies it's better than it is imo
```

---

## Line 22-22

```md
AI can do all of that. It's often good enough, and it does work. But is it _really_ the best for _your_ specific problem? Working this way makes that question harder to answer, not easier.
```

**kw** · comment · 2026-08-08 · `5eabca01-f891-42a9-9b17-cb8883744254`

> work

Context when written:

> …often good enough, and it doeswork. But is it really the best for…

> in what sense

**kw** · comment · 2026-08-08 · now line 22 · `2ab04ebe-c675-461c-a1b4-346bf0d2fead`

> specific problem

> problem as in, programming problem? app-building problem? something else?

---

## Line 26-26

```md
I paid for one month of a Claude Max subscription to do this. That's $100. To say nothing of the fact that many people can't afford that sort of spend, there are a lot of tokens spent on each subagent, each feature, each AI-assisted review cycle or organizational pass. Data centers are expanding rap…
```

**kw** · suggestion · 2026-08-08 · `9907024d-9bca-4907-bf96-d8ecca9786b3`

> spend

Suggested replacement:

```md
budget
```

---

## Line 28-28

```md
I did make some deliberate choices not to reach for the biggest hammer by default. Opus was my primary model, but simpler subagent work — a documentation pass, a formatting cleanup, a first read of a diff — went to Haiku or Sonnet instead. Those are smaller models: fewer calculations per word, and c…
```

**kw** · suggestion · 2026-08-08 · now line 28 · `602c68c2-b1c3-4a31-8909-48796f1cfad9`

> hammer

Suggested replacement:

```md
hammer so to speak
```

**kw** · suggestion · 2026-08-08 · `930a365f-7e1c-4263-923c-bded4e0790e7`

> with

Context when written:

> …ngly less electricity to answerwith. I tried to keep agents few and…

Suggested replacement:

```md
answer using
```

---

## Line 40-40

```md
"We are going to build a directory of safe-streets and urban advocacy organizations. I want this to be a modular application that can be consumed by a number of consumers. To start, let's build this in three pieces, starting with a simple API. This API will be built in Go. You should default to usin…
```

**kw** · suggestion · 2026-08-08 · `4530ee8b-869a-468e-a4f7-faa58b74ab43`

> third party

Suggested replacement:

```md
third-party
```

---

## Line 42-42

```md
Every clause in there is doing work. TDD is test-driven development — writing tests alongside, or in the strictest version before, the implementation — and asking for it up front meant tests existed from the first commit instead of being bolted on months later, when nobody wants to write them. Namin…
```

**kw** · suggestion · 2026-08-08 · now line 42 · `2ff8589c-26fc-4e2a-84d3-36e966493fc5`

> is doing work

Suggested replacement:

```md
has a purpose
```

**kw** · comment · 2026-08-08 · now line 42 · `0da6d41c-16a2-42f0-8e2b-3ff51aa350be`

> test-driven development

> italicize

**kw** · suggestion · 2026-08-08 · now line 42 · `79e2628b-c2c5-4c6f-9a90-182681787f48`

> up front

Suggested replacement:

```md
upfront
```

**kw** · comment · 2026-08-08 · now line 42 · `4acca3fc-08d7-4950-9856-b93da14ee6cb`

> up front

> actually nvm

**kw** · comment · 2026-08-08 · `ed4e339a-6d29-4e2b-98d2-d0f645c9f93a`

> nobody

Context when written:

> …ng bolted on months later, whennobodywants to write them. Naming the…

> who's that in this case, you?

**kw** · comment · 2026-08-08 · now line 42 · `33cb55fc-2f18-419c-ab58-2d3e7990a3c4`

> volunteer it

> volunteer what?

---

## Line 44-44

```md
That prompt names Go, and [the first post](/blog/i-used-ai-to-build-the-urbanist-atlas/) covered how it got there: I left the stack open, Claude suggested Node, and I turned it down because I had specific reasons — static typing, a straightforward concurrency model, and a language I'd shipped a prod…
```

**kw** · comment · 2026-08-08 · now line 44 · `503bbdd9-c040-489a-974a-63b857f05bd5`

> That prompt

> be more specific – e.g., the initial prompt for the Atlas

**kw** · suggestion · 2026-08-08 · now line 44 · `ac121b62-0f54-40ca-bb6e-94fe07281449`

> names

Suggested replacement:

```md
calls for Go
```

**kw** · comment · 2026-08-08 · now line 44 · `b8822eca-630e-4f9e-8556-39b6f3ccd3d2`

> how it got there

> how what got there

**kw** · suggestion · 2026-08-08 · `37fe7a34-f136-4c39-bd53-428c2283df9c`

> open

Context when written:

> …it got there: I left the stackopen, Claude suggested Node, and I t…

Suggested replacement:

```md
open ended
```

**kw** · suggestion · 2026-08-08 · `38383f77-6e50-4826-818c-0ae96946053a`

> first

Context when written:

> …ger gain is doing that thinkingfirst— it gives you something concre…

Suggested replacement:

```md
yourself
```

**kw** · suggestion · 2026-08-08 · `1870dbaf-f796-4059-a5a0-cc73ea890459`

> first

Context when written:

> …ger gain is doing that thinkingfirst— it gives you something concre…

Suggested replacement:

```md
yourself
```

---

## Line 54-54

```md
That's iteration: working the same problem with the same tool until the answer is good. It's necessary. But everything inside that loop is still being judged by the thing that produced it.
```

**kw** · comment · 2026-08-08 · `c11ad3c6-35be-4a58-8fd8-b0fe7292376c`

> But everything inside that loop is still being judged by the thing that produced it.

> truth

---

## Line 62-62

```md
The polygon function from the second post is why I kept doing this even when it felt like overkill. That code ran clean, returned a number, and the number was entirely plausible — a few postal codes just quietly resolved to the wrong metro. No amount of iterating would have surfaced that outcome, be…
```

**kw** · comment · 2026-08-08 · `a75f2aae-3ef6-433b-9605-61e8ee081226`

> no stake

> not sure this is the right word

---

## Line 70-70

```md
A system like that is strongest where your problem is ordinary, because ordinary is what it learned from. It's weakest where your problem is strange. Every hard thing in this project sat at the strange end: a ZIP code whose neighborhood has no border you can look up anywhere, two federal datasets th…
```

**kw** · suggestion · 2026-08-08 · `a8a35996-f98d-42d6-af72-2598ac5a17bb`

> strange

Suggested replacement:

```md
unique/unusual/different
```

**kw** · comment · 2026-08-08 · `df1e67b5-a67c-49c3-9784-3b06e48f196f`

> a polygon with a hole in it

> a bit confusing/opaque

---

## Line 72-72

```md
So the practical version is: hand off the ordinary parts freely, and make a list of the parts that are unusual. That list is where AI will be confidently, plausibly wrong, and it's where your review time should go.
```

**kw** · suggestion · 2026-08-08 · `33a28273-f504-4781-94f8-5eb1f0f058de`

> unusual

Suggested replacement:

```md
atypical
```

---

## Line 76-76

```md
The six inclusion criteria from [the second post](/blog/the-atlas-data-was-the-hard-part/) were the easy half. No training corpus was going to tell me that housing and YIMBY work — a neighboring movement, and a friendly one — sits outside the Atlas's scope, and Open New York is a group I like and le…
```

**kw** · comment · 2026-08-08 · `decec887-8629-456e-a5af-21c8b63a2e73`

> The six inclusion criteria from the second post were the easy half. No training corpus was going to tell me that housing and YIMBY work — a neighboring movement, and a friendly one — sits outside the Atlas’s scope, and Open New York is a group I like and left out anyway. That’s a decision about what the directory is for and who it owes something to, and I’d make it again.

> i find this paragraph a bit hard to follow, particularly the last sentence

---

## Line 78-78

```md
The harder half is that the six rules don't cover their own edges. PedSafe Vegas clears every one of them and I excluded it regardless, because a program housed inside a university is the same call I'd already made about a chapter that doesn't incorporate separately from its state organization. Noth…
```

**kw** · comment · 2026-08-08 · `cb70dc45-6c5e-4618-af57-8b5f4df8fa96`

> edges

Context when written:

> …six rules don’t cover their ownedges. PedSafe Vegas clears every one…

> vague

**kw** · comment · 2026-08-08 · now line 78 · `e11881e9-5c9f-403a-a16f-84a496220e79`

> clears every one of them

> vague

**kw** · comment · 2026-08-08 · `22432451-045d-4284-a09e-950cf0dbd051`

> call

Context when written:

> …inside a university is the samecallI’d already made about a chapte…

> what kind of call

**kw** · comment · 2026-08-08 · now line 78 · `ceea18fd-9b34-40a4-9e30-f0518ca29342`

> Nothing in the published criteria says that

> confusing

**kw** · comment · 2026-08-08 · `2682e21c-ce0b-4047-bc04-7600c4680e32`

> six

Context when written:

> …dn’t know them when I wrote thesix. Each one arrived as a single h…

> might be good to remind us of what these are

---

## Line 80-80

```md
A model can apply criteria like that very well once they exist. Someone has to have chosen them, keep choosing at the edges nobody wrote down, and be willing to defend the result. That set of edges is still growing — every one of them is a call that has to be made before there is a rule to apply.
```

**kw** · comment · 2026-08-08 · `14e2f391-c84f-4369-bd1b-b0377d57b7bb`

> they

Context when written:

> …iteria like that very well oncetheyexist. Someone has to have chos…

> the model?

**kw** · comment · 2026-08-08 · now line 80 · `7a6a34e0-6843-448c-9335-d7e629cf4d23`

> defend the result

> defend against?

**kw** · comment · 2026-08-08 · now line 80 · `30b4f4de-0f7a-44dd-96af-be41438cd9c7`

> every one of them is a call that has to be made before there is a rule to apply

> confusing/hard to follow

---

## Line 86-86

```md
Getting from an idea to a working prototype has never been easier, and I do hope that means more good ideas come to life that otherwise wouldn't. But I'd be wary of anyone handing you a process to copy, mine included. The specific shape of this project came out of what I already had — thirteen years…
```

**kw** · suggestion · 2026-08-08 · `545d9cd9-a609-484f-9a3f-0b1704fe15e4`

> easier

Context when written:

> …orking prototype has never beeneasier, and I do hope that means more…

Suggested replacement:

```md
easier thanks to AI
```

**kw** · comment · 2026-08-08 · now line 86 · `eadfdddb-dc7e-4b72-ae8f-3282f34fae88`

> anyone

> who?

**kw** · comment · 2026-08-08 · now line 86 · `2a89c5da-0951-4ca5-8d09-405f67bd4212`

> what I already had

> to me this reads as tangible things you had not experience

**kw** · suggestion · 2026-08-08 · `0eb0edee-88ac-4ade-920f-ce98c25013ba`

> work

Context when written:

> …had — thirteen years of backendwork, almost no frontend, and a subj…

Suggested replacement:

```md
development work
```

**kw** · comment · 2026-08-08 · now line 86 · `9b9c6953-769d-4b23-a6c2-01cfe9dc0adb`

> Yours

> your what

**kw** · comment · 2026-08-08 · now line 86 · `87dfc274-1af5-4e90-8f4f-2b5cf86fa4df`

> Where you know the domain

> make it clear we're talking about working with ai

---

## Line 88-88

```md
Beyond the model choices I mentioned earlier, the tooling is all there to borrow. Since the code is open source, I'd encourage you to look at my `just` file if you want to take any of it — like the containerized link validation that checks every organization's website through a VPN and flags the dea…
```

**kw** · comment · 2026-08-08 · `ee973fd1-5937-4cd8-9d24-1b340103ceec`

> borrow

Context when written:

> …er, the tooling is all there toborrow. Since the code is open source,…

> borrow or use?

**kw** · comment · 2026-08-08 · now line 88 · `abbf4c1a-a1e4-4aeb-b4c3-4ca614b0febd`

> the code is open source

> your code?

---

## Line 92-92

```md
The kind of borrowing I described is only possible because everything is openly licensed. The code, data, and written content are all publicly available under the [Apache 2.0](https://github.com/mjrossi/urbanist-atlas/blob/main/LICENSE), [ODbL-1.0](https://github.com/mjrossi/urbanist-atlas/blob/main…
```

**kw** · comment · 2026-08-08 · `8ed5c71f-649d-4314-97a0-304090a61f55`

> and

Context when written:

> …under the Apache 2.0, ODbL-1.0andCC-BY-SA-4.0 licenses, respecti…

> oxford comma?

---

## Line 94-94

```md
I hope you will reach out, submit corrections, tell me about a new advocacy org you'd like included. Trust has to be a core value, and trust is built from being open and transparent. Hiding behind a robot, or not being forthcoming about the fact that I am using AI to build, operate, and maintain thi…
```

**kw** · comment · 2026-08-08 · `0c4b8444-d75c-44fe-ac30-83de23f57ed5`

> tell

Context when written:

> …reach out, submit corrections,tellme about a new advocacy org you…

> and

**kw** · comment · 2026-08-08 · now line 94 · `7a66e1e7-c9bc-43c0-aa5b-24fbcd1896ea`

> AI to build, operate, and maintain this site

> kinda weird it's the first we hear of you using ai to maintain the website all the way at the bottom here, not sure it belongs

---

## Line 96-96

```md
AI is going to reshape a lot of how we work in the coming years, and there are powerful incentives pushing that momentum in the wrong direction — maximizing profit even when the costs are borne by people and the planet. Looking back, nearly every place this project succeeded or failed came down to w…
```

**kw** · comment · 2026-08-08 · `ae414199-7283-4b32-9668-580faf87ed35`

> handed off

> handed off to ai

---

## Line 98-98

```md
I've met some incredible activists over the years, and have been inspired by their work and passion for their homes. This project is a love letter to all of them, and my small way of doing my part.
```

**kw** · comment · 2026-08-08 · `dc11c37b-9c05-4089-ba02-ddcc66cd1c9b`

> doing my part

> to what? for urban activism?

---
