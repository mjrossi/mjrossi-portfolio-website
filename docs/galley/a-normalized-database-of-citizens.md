# Review notes — a-normalized-database-of-citizens

Pulled 2026-09-06T14:20:44.845Z from `production`.
36 open notes, 2 reviewer(s).

Notes by section:

```
(section unknown)               16
Who it was built for            2
What a system needs             3
Who you are: the identifier     4
What proves it: the credential  5
Where you live: the register    2
What one change costs           1
What got built instead          1
The price of building it right  2
```

> Each note carries its id. `just galley-close a-normalized-database-of-citizens` closes exactly the ids in this file — notes filed after this pull are left open.

> **36 of these were written against an earlier revision.** Their stored line numbers are stale. Where the quoted text was still findable, the current line is given as "now line N" — otherwise search for the quote by hand.

Source: `src/content/blog/a-normalized-database-of-citizens.mdx`

---

## Line 13-13 — ⚠ revision drift, notes relocated individually below

**kw** · comment · 2026-09-04 · `e629399c-68df-4bbd-94c6-45e38d9e6975`

> closed

Context when written:

> …a certificate before the officeclosed. I walked through the citizen d…

> you would hope so?

**kw** · comment · 2026-09-04 · now line 13 · `76094c56-aed2-4e86-a420-5ecb3873cdf8`

> filing cabinet

> filing cabinet's worth of documents?

---

## Line 15-15 — ⚠ revision drift, notes relocated individually below

**kw** · comment · 2026-09-04 · `20843c48-464c-4dc1-9c26-d018edfba562`

> earned

Context when written:

> …wn. None of that is something Iearned. What stayed with me was not si…

> meritocratically??

**kw** · comment · 2026-09-04 · now line 15 · `d3bd6a76-0264-4d68-9dff-fcb276192bb3`

> something for me in return

> as opposed to?

**kw** · comment · 2026-09-04 · now line 15 · `bd89741d-2fec-46d0-9c0a-63e69165b72f`

> they name

> that those records name

---

## Line 19-19 · Who it was built for — now line 19

```md
The US has built much more of that machinery inside the immigration system than it maintains for its own citizens. Across different statuses, the federal government can assign a lasting identifier, record an arrival, require an address change, follow a change of status, and record a departure. No si…
```

**kw** · comment · 2026-09-04 · `c9b8317b-1a10-461c-b943-baa69f337cc9`

> that machinery

> what machinery

**kw** · comment · 2026-09-04 · `8f8e2af8-6491-4d5a-bce5-25b5cc590e63`

> statuses

> immigration/citizenship statuses or?

---

## Line 21-21 — ⚠ revision drift, notes relocated individually below

**kw** · comment · 2026-09-04 · `ef360722-ebab-4194-aac3-8ef7c059deba`

> That

Context when written:

> …Thatdifference matters because the…

> This paragraph is good!

**hw** · suggestion · 2026-09-05 · now line 21 · `b1d5d53c-4e4b-4152-b634-e30697605b9a`

> Neither gets a public identity system designed first around the person using it.

> Can't add note to table but unsure what "none — and no register to write it to" means next to change of address. Do you mean "none—and nowhere to register it"?

Suggested replacement:

```md
change of address: none—and nowhere to register it
```

**hw** · suggestion · 2026-09-05 · now line 21 · ↳ same passage as above · `37950416-0e8b-4e18-b915-7d5d42407891`

> Neither gets a public identity system designed first around the person using it.

> Another note for the table: 
> Form AR-11
> within 10 days of moving —
> 8 U.S.C. § 1305, a criminal offense
>
> what is a criminal offense, not submitting the form?

Suggested replacement:

```md
"skipping this is a criminal offense"
```

---

## Line 25-25 — ⚠ revision drift, quote not found

**kw** · comment · 2026-09-04 · `62afa835-e737-489a-b2d2-5e172de763b4`

> know

Context when written:

> …ecord of who a state decided toknow.…

> weird phrasing

---

## Line 29-29 · What a system needs — now line 29

```md
As an engineer, I recently worked on an identity and authorization system, and the first thing I had to settle is the thing a government has to settle too.
```

**kw** · comment · 2026-09-04 · `790af6bf-4417-4bee-9965-31785e0b8b6c`

> settle

> figure out

---

## Line 31-31 — ⚠ revision drift, quote not found

**kw** · comment · 2026-09-04 · `5eca07db-c51a-4238-8335-d33090374bc6`

> practical

Context when written:

> …That’s thepracticalpoint of normalization in a dat…

> can delete

---

## Line 33-33 · What a system needs — now line 55

```md
By that standard the US has neither for its citizens. Each agency keeps the record it needs for its own purpose, so proving the specifics of one person means cross-referencing a driver's license here, a lease there, and a utility bill standing in as proof that "this person exists at this address." A…
```

**hw** · suggestion · 2026-09-05 · `a17b6abb-8ae5-44bc-b501-a57af0cf4a4f`

> “this person exists at this address.” All of it accepted as commonplace.

> I would add this as an aside, all of it accepted as commonplace is not a full sentence

Suggested replacement:

```md
"this person exists at this address" — all of it accepted as commonplace.
```

---

## Line 35-35 · What a system needs — now line 57

```md
Strip the problem down and there are only three questions any identity system has to answer: who you are, what proves it, and where you live.
```

**hw** · comment · 2026-09-05 · `7fde0e4a-2001-419a-a505-fa10056afbc6`

> who you are, what proves it, and where you live.

> note for the table:
> Cartão de Cidadão
> + Chave Móvel Digital
>
> unlike the italy "who you are" cell, for which agenzia delle entrate is at least guessable, I am unsure what the chave movel digital is, possible to add english notes to both?

---

## Line 45-45 · Who you are: the identifier — now line 116

```md
Italy does the same, and I learned it years ago. Italian identity documents and citizen identifiers are far more formalized than the US equivalents. My codice fiscale — the Italian equivalent of a Social Security number, issued by the Agenzia delle Entrate — identifies me permanently, and it is prin…
```

**kw** · comment · 2026-09-04 · `aa4c0bc4-2883-478a-8d6f-4aa1052db91b`

> issued by it

> issued by... the card?

---

## Line 49-49 · Who you are: the identifier — now line 120

```md
The NIF and the codice fiscale are designed as identifiers rather than authenticators — public from the start, the codice fiscale computable from a person's own details, the NIF verifiable by its check digit. No second credential is universally held in the US, so "knows the number" became proof of i…
```

**hw** · suggestion · 2026-09-05 · `72557079-1b6e-4985-a5ee-3c92e210064f`

> the codice fiscale computable from a person’s own details, the NIF verifiable by its check digit

> there should be "is" before computable and before verifiable. is this an AI-ism?

Suggested replacement:

```md
the codice fiscale is computable from a person’s own details, the NIF is verifiable by its check digit
```

**hw** · suggestion · 2026-09-05 · `a3959bbe-6f66-48fd-adbd-0c9224dd8525`

> doing

> doing should be does

Suggested replacement:

```md
does
```

---

## Line 53-53 · Who you are: the identifier — now line 124

```md
Parts of the immigration system go further because they hang off federal documents. E-Verify can put a government-held photo in front of an employer when a new hire presents one of several federal documents; SAVE lets state agencies check immigration status. A citizen carrying only a state driver's …
```

**hw** · comment · 2026-09-05 · `8cf5a41c-4856-403c-a0a6-794aa4974eb0`

> SAVE

> spell out the acronym for SAVE on first reference

---

## Line 55-55 — ⚠ revision drift, quote not found

**hw** · comment · 2026-09-05 · `f7a94530-8677-410a-b3e0-5f7d47bcc07a`

> USCIS

Context when written:

> …Many people who pass throughUSCISalso receive a purpose-built id…

> spell out USCIS on first reference (ideally in the note for the table that it first appears in, but understand if there isn't room.)

---

## Line 61-61 · What proves it: the credential — now line 132

```md
European identity systems make identification an explicit part of civic life, rather than borrowing a document issued for driving. For Italy, that is the Carta d'Identità Elettronica (CIE), a national card built to common EU security standards. It carries my codice fiscale and an NFC chip that can a…
```

**hw** · comment · 2026-09-05 · `6b4e35e2-80d4-49c8-982f-0f409ecb77cf`

> NFC

> NFC referenced in above table, similar to previous note, I would spell out on first reference, either here or in the footnote to the table

---

## Line 63-63 · What proves it: the credential — now line 134

```md
Most Italians still use SPID, a separately issued digital credential, to log in to public services. The government is gradually moving those logins toward the CIE and the IT Wallet, but the transition is unfinished. That matters less here than the direction of travel: Italy has an identifier and a c…
```

**hw** · comment · 2026-09-05 · `f539e725-b65b-4bd7-b221-957524150879`

> SPID

> similar to CIE, I would spell out SPID on first reference

---

## Line 65-65 · What proves it: the credential — now line 136

```md
Portugal implements its own version of this. Citizens receive a Cartão de Cidadão. The rest of us use a passport or residence title tied to us. Either way the credential stays separate from the document: most commonly the [Chave Móvel Digital](https://www.autenticacao.gov.pt/a-chave-movel-digital), …
```

**hw** · comment · 2026-09-05 · `e9775adc-0feb-4cbd-8a75-6dec554025fa`

> eIDAS

> same note

---

## Line 69-69 · What proves it: the credential — now line 140

```md
The US license has to prove both identity and residency at once, and it falls apart very quickly on the second. People move and keep the old license until it expires.
```

**hw** · comment · 2026-09-05 · `7d18a37e-2983-4e58-84bc-cfda250870b2`

> People move and keep the old license until it expires.

> oopsy

---

## Line 71-71 · What proves it: the credential — now line 142

```md
US non-citizens, meanwhile, have a very different situation. United States Citizenship and Immigration Services (USCIS) issues several federal photo IDs. The permanent resident card (Form I-551, known colloquially as a green card) is the obvious example, and the Employment Authorization Document (Fo…
```

**hw** · comment · 2026-09-05 · `f0031a73-f95f-499e-8f98-a3384b508bde`

> United States Citizenship and Immigration Services (USCIS)

> when defined above, can change this to just the acronym

---

## Line 77-77 · Where you live: the register — now line 148

```md
As an Italian citizen studying and legally residing in Portugal, signing a lease was only the first half of arriving. Free movement gives any EU citizen an unconditional right to be in Portugal for three months; past that, you are required to register your presence with the municipality you live in,…
```

**hw** · comment · 2026-09-05 · `2b7ec59c-0f27-46e2-ac48-453523f2f552`

> Free movement

> is this an official policy? should movement be capitalized?

---

## Line 79-79 — ⚠ revision drift, quote not found

**hw** · comment · 2026-09-05 · `b80be8f4-71e2-4c6a-a40b-d3af637dd2e9`

> what

Context when written:

> …ing two of the three questions:whatproves who I am, and where I li…

> I think what should be "it" here

---

## Line 85-85 · Where you live: the register — now line 156

```md
That differs sharply from the US, where I could move to New York and, unless I wanted a New York driver's license, go a long time without telling anyone I lived there, right up until I had to file a New York tax return. The US produces many answers to the question "where do you live," each authorita…
```

**hw** · suggestion · 2026-09-05 · `d490cbd9-ad13-4568-8cd6-beb1204cb588`

> “where do you live,” each authoritative

> change to semi colon and add is before authoritative

Suggested replacement:

```md
“where do you live,” each is authoritative
```

---

## Line 95-95 · What one change costs — now line 166

```md
Changing an address is where the architecture stops being abstract. In Italy, a resident writes the change once to the national population register, the ANPR, and downstream agencies can receive it from there. This is replication rather than a true foreign key, but it moves toward what the EU calls …
```

**hw** · comment · 2026-09-05 · `6eaad2f6-7edc-4cf3-82fd-3f96c79d4c4f`

> ANPR

> define

---

## Line 97-97 — ⚠ revision drift, quote not found

**hw** · comment · 2026-09-05 · `37c18288-8eb9-475f-bce6-0fefabdeccbc`

> but no

Context when written:

> …for each administrative domain,but nosingle resident record connecti…

> either "but has no" or "there is no"

---

## Line 99-99 — ⚠ revision drift, quote not found

**hw** · comment · 2026-09-05 · `7072bdae-c6e2-462e-9d7f-fa2e7a3eba9a`

> normalization

Context when written:

> …y, exactly the ordinary failurenormalizationis meant to prevent.…

> that normalization

**hw** · comment · 2026-09-05 · `de817d69-3ad1-4c3b-a8c9-1af3e01e0ffc`

> prevent

Context when written:

> …ilure normalization is meant toprevent.…

> note for table and perhaps this is connected to one of my first notes, I am confused by using "a write" as a noun

---

## Line 107-107 — ⚠ revision drift, quote not found

**hw** · suggestion · 2026-09-05 · `f173f43f-b11e-4dc9-9152-eb2e0b2eb4c7`

> refusal

Context when written:

> …The USrefusalto build a federal population r…

> refusal feels harsh/combative, not sure if you want that tone printed
>
> The United States' lack of federal population register

Suggested replacement:

```md
"The United States' lack of federal population register"
```

---

## Line 111-111 · What got built instead — now line 182

```md
The contrast is clearest when I enter each country. Returning to the US as a citizen without Global Entry means a manual immigration queue. To make that experience frictionless, I have to apply, pay a fee, undergo a background check, give fingerprints, sit for an interview, and repeat the process ev…
```

**hw** · comment · 2026-09-05 · `292b30ad-348f-41ee-993d-6b18eeb8a700`

> and repeat the process every five years

> didn't we renew GE without repeating the interview process?

---

## Line 127-127 · The price of building it right — now line 198

```md
Refusing to build a public system never prevented the surveillance; it privatized much of it and withheld the useful utility. Build one without these protections, though, and all we have done is finish the surveillance state for citizens and immigrants both. Normalization is not politically neutral.
```

**kw** · comment · 2026-09-04 · `ae0cea6f-d2d2-4ab0-9507-4fe01d66f7d2`

> neutral

> good conclusion! overall a big improvement from draft 1 to this – nice work

**hw** · suggestion · 2026-09-05 · `37c6f681-56f4-4193-9da9-a8d87a3ad3da`

> Refusing

Suggested replacement:

```md
Opting not to build
```

---
