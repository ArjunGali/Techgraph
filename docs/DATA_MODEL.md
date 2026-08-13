# TechGraph — Graph Data Model

This document is the single source of truth for the graph schema. The seed
script (`server/seed/`) and every Cypher query (`server/queries/`) match it
exactly.

## Modeling principles

1. **The graph is the product.** Every core feature (explore, connect, career
   path) is answered by *traversing relationships*, never by filtering a flat
   list. Nothing the app recommends is stored as a precomputed answer.
2. **Every edge is a true real-world statement.** A relationship may only
   exist if a practitioner would say it out loud ("PyTorch requires Python",
   "Google hires ML Engineers"). No edge exists merely to make a demo
   traversal possible.
3. **Skills are what a person knows; Technologies are what a stack uses.**
   Programming languages (Python, SQL, JavaScript) are `Skill` nodes because
   people *know* Python. Frameworks, tools and platforms (PyTorch, React,
   Docker) are `Technology` nodes because stacks *use* PyTorch. This split
   keeps skill-to-job traversals meaningful instead of circular.
4. **Every node has a unique `name` within its label.** Lookups are always
   `(label, name)` pairs, which keeps API routes and Cypher parameters simple.
5. **Reuse the assignment's relationship vocabulary before inventing new
   types.** The schema uses exactly the seven relationship types from the
   brief (`LEADS_TO`, `WORKS_WITH`, `USED_FOR`, `REQUIRES`, `USES`,
   `HIRES_FOR`, `TEACHES`) — no additions.

## Node labels

| Label | Properties | Examples |
|---|---|---|
| `Skill` | `name` (unique), `description`, `category`: `"language"` \| `"data"` \| `"practice"` \| `"domain"`, `difficulty`: `"beginner"` \| `"intermediate"` \| `"advanced"` | Python, SQL, Git, Machine Learning |
| `Technology` | `name` (unique), `description`, `type`: `"framework"` \| `"library"` \| `"tool"` \| `"platform"` \| `"database"` | PyTorch, React, Docker, PostgreSQL |
| `Concept` | `name` (unique), `description`, `field`: `"AI/ML"` \| `"web"` \| `"data"` \| `"infrastructure"` | Deep Learning, REST APIs, Containerization |
| `Job` | `name` (unique), `description`, `level`: `"junior"` \| `"mid"` \| `"senior"`, `avgSalaryUSD` (integer) | ML Engineer, Data Engineer, Frontend Developer |
| `Company` | `name` (unique), `description`, `industry` | Google, Netflix, Spotify |
| `Course` | `name` (unique), `description`, `provider`, `url`, `level`: `"beginner"` \| `"intermediate"` \| `"advanced"` | Deep Learning Specialization |

## Relationship catalog

| # | Pattern | Meaning (read out loud) | Properties |
|---|---|---|---|
| 1 | `(:Skill)-[:LEADS_TO]->(:Skill)` | "Learning A naturally progresses you toward B" | — |
| 2 | `(:Technology)-[:REQUIRES]->(:Skill)` | "Using this technology presupposes competence in this skill" | — |
| 3 | `(:Technology)-[:WORKS_WITH]->(:Technology)` | "These are commonly used together in real stacks" (symmetric; stored once, matched undirected) | — |
| 4 | `(:Technology)-[:USED_FOR]->(:Concept)` | "This technology exists to implement/enable this concept" | — |
| 5 | `(:Job)-[:REQUIRES]->(:Skill)` | "This role's listings ask for this skill" | `level`: `"core"` \| `"nice-to-have"` |
| 6 | `(:Job)-[:USES]->(:Technology)` | "This technology is part of the role's day-to-day stack" | — |
| 7 | `(:Company)-[:HIRES_FOR]->(:Job)` | "This company hires this role" | — |
| 8 | `(:Course)-[:TEACHES]->(:Technology or :Skill)` | "This course's curriculum covers it" | — |

`REQUIRES` appears twice with one consistent meaning — *"presupposes
competence in"* — applied from two directions: a technology presupposes
skills, and a job presupposes skills. Only the job variant carries `level`,
because job requirements come in priority tiers while a technology's
prerequisite is inherently mandatory (an optional prerequisite is not a
prerequisite).

## Why each relationship exists

**1. `Skill-[:LEADS_TO]->Skill` — learning progression.**
*Real world:* pedagogical reality — you learn Python before machine learning,
Git before CI/CD. *Why an edge:* progression is a fact about the ordered
pair, and direction carries the meaning (Python leads to ML, never the
reverse). *Used by:* the Path Builder's learning-route traversal
(`[:LEADS_TO*1..3]`) and "what should I learn next" suggestions.

**2. `Technology-[:REQUIRES]->Skill` — competence prerequisite.**
*Real world:* PyTorch is a Python framework — you cannot use it without
Python; React presupposes JavaScript; Kubernetes presupposes containerization
practice. *Why an edge:* the prerequisite binds a specific (technology,
skill) pair. *Used by:* traversed forward it answers "what must I know before
picking up X?"; traversed backward ("what does knowing Python unlock?") it is
the bridge from the skill layer into the technology layer in career-path
traversals — and it earns that role by being true, not by being convenient.

**3. `Technology-[:WORKS_WITH]->Technology` — stack affinity.**
*Real world:* tools cluster in practice: PyTorch + NumPy, React + Vite,
Docker + Kubernetes. *Why an edge:* affinity is pairwise and has no natural
home on either node. It is semantically symmetric, so the seed stores each
pair once and queries match it without direction (`-[:WORKS_WITH]-`). *Used
by:* required query #3 ("technologies related to a technology"), Explorer
neighborhoods, stack suggestions in the Path Builder.

**4. `Technology-[:USED_FOR]->Concept` — purpose.**
*Real world:* PyTorch exists for deep learning; Docker exists for
containerization. *Why an edge:* it separates *what a tool is* from *what a
tool is for*, letting many tools point at one purpose. *Used by:* the
Explorer's context view, and the shared-purpose pattern — two technologies
pointing at the same concept are surfaced in the UI as *related technologies*
(see traversal T3 below), a classic common-neighbor query that showcases
graph thinking.

**5. `Job-[:REQUIRES {level}]->Skill` — hiring requirement.**
*Real world:* job listings distinguish must-haves from nice-to-haves. *Why an
edge:* the requirement binds a (job, skill) pair; see the dedicated section
below for why `level` lives on the edge. *Used by:* required query #2 ("jobs
requiring a skill") and the Path Builder's gap analysis ("you're missing 2
core skills, 1 nice-to-have").

**6. `Job-[:USES]->Technology` — the role's stack.**
*Real world:* ML Engineers work in PyTorch day to day; frontend developers
work in React. *Why an edge:* distinct from `REQUIRES` — a stack tool is what
you'd *touch on the job*, not an interview gate; conflating them would make
both queries lie. *Used by:* job detail views, career-path endpoints
(reaching a job through the technologies it uses), and course recommendations
for a target job's stack.

**7. `Company-[:HIRES_FOR]->Job` — the labor market.**
*Real world:* companies post openings for roles. *Why an edge:* it connects
the career graph to actual employers, which is what makes a *career* explorer
rather than a curriculum diagram. *Used by:* "who hires for this role/skill"
(traversal T4), dashboard statistics, and as the far endpoint of long
Connection Explorer paths. The seed's `HIRES_FOR` edges use real company
names but are illustrative demo data, not claims about current openings
(also disclosed in the README).

**8. `Course-[:TEACHES]->Technology|Skill` — curriculum coverage.**
*Real world:* a course teaches concrete things: a specialization teaches
PyTorch (technology) and machine learning (skill). Both targets are real, so
both are allowed. *Why an edge:* coverage binds (course, subject) pairs.
*Used by:* the Path Builder's final step — after computing *missing* skills
and technologies, one hop through `TEACHES` turns the gap into an actionable
study plan. Recommendations are traversal results, never hard-coded.

## Design decision: replacing `Skill-[:WORKS_WITH]->Technology`

The Phase-1 draft included `(:Skill)-[:WORKS_WITH]->(:Technology)` as the
bridge between the skill and technology layers. Review scrutiny removed it:
"Python works with PyTorch" is the fact stated **backwards** — the real-world
relationship is that *PyTorch presupposes Python*. It is now modeled as
`(:Technology)-[:REQUIRES]->(:Skill)`, which:

- states the true dependency direction (tool depends on competence);
- reuses the assignment's existing `REQUIRES` vocabulary with the same
  meaning it has on `Job-[:REQUIRES]->Skill` (no new relationship type);
- keeps `WORKS_WITH` purely symmetric (tech ↔ tech only), instead of
  overloading it with an asymmetric second meaning;
- still provides the skill→technology bridge for traversals — but now the
  bridge is a real statement, which is exactly what the "why a graph
  database?" argument needs to survive an interview.

## Why `level` is a relationship property

`(:Job)-[:REQUIRES {level: "core" | "nice-to-have"}]->(:Skill)`

The importance of a skill is a fact about the **pair**, not about either node:

- **Not on `Skill`:** Python is `core` for an ML Engineer but merely
  `nice-to-have` for a Frontend Developer. A single flag on the Python node
  cannot express both — it would be globally wrong for every job but one.
- **Not on `Job`:** the job node would need a map like
  `{"Python": "core", "SQL": "nice-to-have"}` — a denormalized copy of the
  edge list that duplicates what the relationships already say, drifts out of
  sync, and cannot be used inside a `MATCH` pattern.
- **On the edge:** the property sits exactly where the fact lives and stays
  filterable mid-traversal:
  `MATCH (j:Job)-[r:REQUIRES]->(s:Skill) WHERE r.level = 'core'`.

Relational readers can map this directly: `level` would be a column on the
`job_skill` join table — and a graph edge *is* the join table row, first-class
and traversable.

## Diagram

```
                            LEADS_TO
                           ┌────────┐
                           ▼        │
                       ┌───┴────┐
        ┌────────────► │ Skill  │ ◄─────────────┐
        │   REQUIRES   └────────┘               │  REQUIRES
        │   (tech needs    ▲                    │  {level: core |
        │    this skill)   │ TEACHES            │   nice-to-have}
        │                  │                    │
 ┌──────┴───────┐      ┌───┴────┐           ┌───┴────┐   HIRES_FOR   ┌─────────┐
 │  Technology  │ ◄────┤ Course │           │  Job   │ ◄─────────────┤ Company │
 └──────────────┘ TEACHES──────┘            └────────┘               └─────────┘
    │    ▲  │  ▲                                │
    │    └──┘  └────────────── USES ────────────┘
    │   WORKS_WITH
    │   (tech ↔ tech, symmetric)
    ▼ USED_FOR
 ┌─────────┐
 │ Concept │
 └─────────┘
```

All eight patterns: `Skill→Skill` (LEADS_TO), `Technology→Skill` (REQUIRES),
`Technology↔Technology` (WORKS_WITH), `Technology→Concept` (USED_FOR),
`Job→Skill` (REQUIRES {level}), `Job→Technology` (USES), `Company→Job`
(HIRES_FOR), `Course→Technology|Skill` (TEACHES).

## Example subgraph (real seed entries)

```cypher
// ---- Nodes ----
(python:Skill {name: "Python", category: "language", difficulty: "beginner",
  description: "General-purpose programming language; the default choice for data and ML work."})

(ml:Skill {name: "Machine Learning", category: "domain", difficulty: "advanced",
  description: "Designing, training and evaluating models that learn patterns from data."})

(sql:Skill {name: "SQL", category: "data", difficulty: "beginner",
  description: "Querying and transforming data in relational databases."})

(pytorch:Technology {name: "PyTorch", type: "framework",
  description: "Open-source deep learning framework with a Python-first API."})

(numpy:Technology {name: "NumPy", type: "library",
  description: "Fundamental package for numerical computing in Python."})

(dl:Concept {name: "Deep Learning", field: "AI/ML",
  description: "Multi-layer neural networks; the engine behind modern AI systems."})

(mle:Job {name: "ML Engineer", level: "mid", avgSalaryUSD: 145000,
  description: "Builds, trains and ships machine-learning systems to production."})

(google:Company {name: "Google", industry: "Technology",
  description: "Search, cloud and AI products at global scale."})

(pdl:Course {name: "PyTorch for Deep Learning Bootcamp", provider: "Udemy",
  url: "https://www.udemy.com/course/pytorch-for-deep-learning/", level: "intermediate",
  description: "Hands-on course building neural networks in PyTorch from scratch."})

// ---- Relationships ----
(python)-[:LEADS_TO]->(ml)                          // learning Python opens the road to ML
(pytorch)-[:REQUIRES]->(python)                     // you can't use PyTorch without Python
(pytorch)-[:REQUIRES]->(ml)                         // ...or without ML understanding
(pytorch)-[:WORKS_WITH]->(numpy)                    // tensors interoperate with ndarrays
(pytorch)-[:USED_FOR]->(dl)                         // PyTorch exists to do deep learning
(mle)-[:REQUIRES {level: "core"}]->(python)         // every MLE listing asks for Python
(mle)-[:REQUIRES {level: "core"}]->(ml)
(mle)-[:REQUIRES {level: "nice-to-have"}]->(sql)    // helpful, not a gate
(mle)-[:USES]->(pytorch)                            // day-to-day stack
(google)-[:HIRES_FOR]->(mle)
(pdl)-[:TEACHES]->(pytorch)
(pdl)-[:TEACHES]->(ml)
```

## Example traversals

**T1 — THE assignment showpiece: multi-hop career discovery (3 hops across
3 node types — 4 nodes, 3 distinct labels — using 3 relationship types).**

```cypher
MATCH path = (s:Skill {name: $skill})-[:LEADS_TO*1..2]->(:Skill)
             <-[:REQUIRES]-(t:Technology)<-[:USES]-(j:Job)
RETURN path
```

Concrete instance with the seed above (`$skill = "Python"`):

```
(Python)-[:LEADS_TO]->(Machine Learning)<-[:REQUIRES]-(PyTorch)<-[:USES]-(ML Engineer)
```

Read out loud: *"Python leads you into machine learning; PyTorch builds on
machine learning; ML Engineer roles use PyTorch every day."* The UI renders it
in learning order — Python → Machine Learning → PyTorch → ML Engineer — which
is exactly the assignment's example journey, produced entirely by traversal.
(Two of the arrows are traversed against their stored direction; the *stored*
directions stay semantically truthful, and Cypher traverses either way.)

**T2 — From a skill to a study plan (2 hops).**

```cypher
MATCH (s:Skill {name: $skill})<-[:REQUIRES]-(t:Technology)<-[:TEACHES]-(c:Course)
RETURN t, c
```

*"You know Python → PyTorch is within reach → the PyTorch for Deep Learning
Bootcamp teaches it."* Powers the Path Builder's course suggestions.

**T3 — Technologies sharing a common purpose (2 hops, common-neighbor
pattern).**

```cypher
MATCH (a:Technology {name: $technology})-[:USED_FOR]->(c:Concept)<-[:USED_FOR]-(other:Technology)
RETURN c, other
```

*"PyTorch is used for Deep Learning; so is TensorFlow — they serve the same
purpose."* The UI presents these as **related technologies**: sharing a
`USED_FOR` concept is evidence of relatedness, not proof of substitutability,
so the app never claims one technology can replace another. In SQL this is a
self-join through two junction-table rows; in the graph it is the natural
shape of the question.

**T4 — Employers reachable from a skill (2 hops, edge-property filter
mid-path).**

```cypher
MATCH (s:Skill {name: $skill})<-[r:REQUIRES {level: "core"}]-(j:Job)<-[:HIRES_FOR]-(co:Company)
RETURN j, co
```

*"Which companies hire roles where Python is a core requirement?"*

**T5 — Connection Explorer: arbitrary path between any two entities
(variable length, heterogeneous).**

```cypher
MATCH (a) WHERE $fromLabel IN labels(a) AND a.name = $fromName
MATCH (b) WHERE $toLabel  IN labels(b) AND b.name = $toName
MATCH p = shortestPath((a)-[*..6]-(b))
RETURN p
```

Endpoints are always identified by an unambiguous `(label, name)` pair, never
by name alone. Cypher cannot parameterize a label inside a `MATCH` pattern,
so `$label IN labels(n)` is the standard fully-parameterized way to pin the
label — no string concatenation involved.

*"How is Git connected to Google?"* → e.g. `(Git)<-[:REQUIRES]-(DevOps
Engineer)<-[:HIRES_FOR]-(Google)`. The endpoints can be any of the six labels
and the hop count is unknown in advance — the query that is one line of
Cypher and a recursive-CTE nightmare across half a dozen join tables in SQL.
This is the centerpiece of the "why a graph database?" argument.

## Constraints & indexes (created by the seed script)

- Uniqueness constraint on `name` for each of the six labels — guarantees
  integrity and gives every `(label, name)` lookup an index for free.

## Scale

76 nodes and 185 relationships (exact counts, defined in `server/seed/data.js`):
dense enough that multi-hop paths genuinely exist between most skill/job
pairs, small enough for a free-tier instance and for a human to reason about
the whole graph.

| Label | Nodes | | Relationship | Edges |
|---|---|---|---|---|
| Skill | 16 | | LEADS_TO | 15 |
| Technology | 21 | | REQUIRES (Technology→Skill) | 29 |
| Concept | 14 | | WORKS_WITH | 16 |
| Job | 8 | | USED_FOR | 25 |
| Company | 8 | | REQUIRES (Job→Skill) | 33 |
| Course | 9 | | USES | 28 |
| | | | HIRES_FOR | 21 |
| | | | TEACHES | 18 |
| **Total** | **76** | | **Total** | **185** |
