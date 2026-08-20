---
title: Kitchen sink
author: fixture
tags: tables, tasks, footnotes
---

# Kitchen sink

> **Live reload** — this line was just added. If you can read it, the file on disk synced into the viewer.

Every markdown shape MarkdownKit currently renders. Open this from **File → Open**, then follow [the linked note](./linked.md#more) and use **Back**.

## Headings

### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6 {#custom-id}

## Emphasis

Regular paragraph with *italic*, **bold**, ***both***, ~~strike~~, `inline code`, and a [web link](https://example.com).

Line one with a hard break.  
Line two.

## Lists

- Unordered one
- Unordered two
  - Nested
  - Nested again
1. Ordered one
2. Ordered two
   1. Nested ordered

## Tasks

- [x] Render checkboxes
- [ ] Leave the unchecked ones empty
- [x] Keep them read-only

## Table

| Align left | Center | Right |
| --- | :---: | ---: |
| tea | 2 | 12 |
| bread | 1 | 4 |

## Quote and rule

> A callout-looking blockquote.
>
> Nested thought.

---

## Code

```rust
fn main() {
    println!("kitchen sink");
}
```

```
plain fence
```

## Diagram

```mermaid
flowchart LR
  Disk[Note on disk] --> Viewer[MarkdownKit]
  Viewer --> Page[Calm page]
  Page --> Next[Follow a local link]
  Next --> Viewer
```

A bigger one, meant to feel tight in the column and roomy when expanded:

```mermaid
flowchart TB
  subgraph Authoring
    A1[Write note] --> A2[Save to disk]
    A2 --> A3{Has mermaid fence?}
    A3 -->|no| A4[Skip mermaid.js]
    A3 -->|yes| A5[Load mermaid once]
  end

  subgraph Render
    R1[pulldown-cmark] --> R2[Sanitize HTML]
    R2 --> R3[Rewrite local links]
    R3 --> R4[Rewrite images]
    R4 --> R5[Task list markup]
    A5 --> R6[Draw SVG]
  end

  subgraph App
    U1[Tauri window] --> U2[Open path]
    U2 --> R1
    R6 --> U3[Calm page]
    U3 --> U4[Expand diagram]
    U4 --> U5[Full-window modal]
    U5 --> U3
  end

  subgraph Serve
    S1[markdownkit-serve] --> S2[GET /]
    S2 --> S3{path query?}
    S3 -->|no| S4[Home form]
    S3 -->|yes| S5[Same renderer]
    S5 --> S6[HTTP HTML]
    S4 --> S7[Open in new tab]
    S7 --> S5
  end

  A1 --> U1
  A2 --> S1
  R5 --> U3
  R5 --> S6
  S6 --> S8[Tailscale Serve]
  S8 --> S9[Other machine]
```

## Image

![Mark](./images/mark.svg)

## Footnote

A claim with a note.[^note]

[^note]: Footnotes collect at the bottom.

## Auto link

<https://example.com/path>

See also [welcome](./welcome.md) if you want to walk the history stack.
