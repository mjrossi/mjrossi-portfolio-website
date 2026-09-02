# Review notes — a-normalized-database-of-citizens

Pulled 2026-09-02T09:52:09.460Z from `production`.
9 open notes, 1 reviewer(s).

Notes by section:

```
Who it was built for          5
What a system needs           1
Who you are: the identifier   2
Where you live: the register  1
```

> Each note carries its id. `just galley-close a-normalized-database-of-citizens` closes exactly the ids in this file — notes filed after this pull are left open.

Source: `src/content/blog/a-normalized-database-of-citizens.mdx`

---

## Line 17-17 · Who it was built for

```md
The US does have something much closer to a normalized identity database — canonical record, a stable join key every system can point at, one authoritative owner, mandatory propagation on change — it just lives in the immigration system. A non-citizen gets the join key and the propagation, but they …
```

**kw** · comment · 2026-09-02 · `b3d45635-0514-44e3-8a27-c1da699a6468`

> much closer

Context when written:

> …The US does have somethingmuch closerto a normalized identity databa…

> much closer than?

**kw** · comment · 2026-09-02 · `555221f0-817e-40ce-bc0e-e91338759b5b`

> join key

Context when written:

> …se — canonical record, a stablejoin keyevery system can point at, one…

> what's this?

**kw** · comment · 2026-09-02 · `a53c1d27-90a4-4ab6-b071-be6eeec235b6`

> The

Context when written:

> …TheUS does have something much clo…

> in general this first paragraph is written in a jargony way i'd say, maybe try to simplify the phrasing and language

---

## Line 19-19 · Who it was built for

```md
I walked through the EU citizen door in Portugal and had a certificate the same afternoon. I walked through the citizen door in America and got a filing cabinet. Same person, two paths, and the path is what determined the schema I experienced. None of that is something I earned.
```

**kw** · comment · 2026-09-02 · now line 19 · `4c6fb8d5-e8e7-4c4b-966e-7795e5421669`

> filing cabinet

> a bit confusing without context

**kw** · comment · 2026-09-02 · `36a3be3f-3ff0-4d68-bee2-e1e0b1b56a3d`

> schema

Context when written:

> …the path is what determined theschemaI experienced. None of that is…

> also confusing

---

## Line 31-31 · What a system needs

```md
Two definitions first: a canonical record is one entry. In this case, that entry is the resident. The resident has an identifier stable enough that every other system can point at it. A single source of truth means there is one place that owns a specific fact about that resident, and every other cop…
```

**kw** · comment · 2026-09-02 · `6ef2b4c4-5837-4da1-adff-78ed3968c40e`

> go

Context when written:

> …there is never a second copy togoquietly out of date.…

> goes?

---

## Line 41-41 · Who you are: the identifier

```md
The Portuguese Número de Identificação Fiscal (NIF) is a tax identification number. It is analogous to the US Social Security number. I went to the pet store the afternoon we arrived, and they asked me for it. I was so confused — why would a store want this? I assumed that, like my Social Security n…
```

**kw** · comment · 2026-09-02 · `49a62299-5bb4-4a4a-b68a-de22aec0923c`

> arrived

Context when written:

> …the pet store the afternoon wearrived, and they asked me for it. I wa…

> in Portugal?

---

## Line 47-47 · Who you are: the identifier

```md
My instinct to guard these numbers came from growing up in the US. The Social Security number is the closest thing an American has to a unique identifier. It was never intended to be, though. From 1946 to 1972, the card itself carried "NOT FOR IDENTIFICATION." Chris Hibbert, who maintained a long-ru…
```

**kw** · comment · 2026-09-02 · `11133a69-9963-47fe-bf2c-5f0170b7f686`

> carried

> displayed?

---

## Line 81-81 · Where you live: the register

```md
The document that records it is the Certificado de Registo de Cidadão da União Europeia (CRUE), Portugal's implementation of [Directive 2004/38/EC](https://eur-lex.europa.eu/eli/dir/2004/38/oj/eng) — the same instrument that requires Italy to issue me an identity card also establishes my right to mo…
```

**kw** · comment · 2026-09-02 · `0dc2a60b-f98d-4129-89bf-b7e99cab8ab3`

> questions

Context when written:

> …ive, answering two of the threequestions.…

> which questions?

---
