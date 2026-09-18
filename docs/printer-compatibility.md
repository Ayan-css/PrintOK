# Printer compatibility matrix

**Nothing in this document has been verified by the author of this file.** It is
the test plan and the record; the Verified column is for a human with a printer
in front of them to fill in. Every row currently reads `UNVERIFIED` because no
hardware test has been run as part of producing it.

One document has printed successfully through PrintOk, on two printers. That is
the entire body of real-world evidence, and it covers one row below.

## How to use this

Run each case against one printer, fill in the result, and record the printer's
make, model and driver. A case that cannot be run — no duplex unit, no A3 tray —
is recorded as `N/A`, not as a pass.

A result is only a pass if the **paper matches what the customer chose and paid
for**. "It printed" is not a pass: printing in colour a job that was bought as
black and white is the exact defect this matrix exists to catch, and it was
found by a shop owner, not by a test.

### Printer under test

| Field | Value |
|---|---|
| Make and model | |
| Driver name and version | |
| Connection (USB / network) | |
| Windows version | |
| Agent version | |
| Tested by | |
| Date | |

## Core matrix

| # | Case | What a pass looks like | Verified |
|---|---|---|---|
| 1 | Mono printer, B&W job | Prints, no colour attempted | UNVERIFIED |
| 2 | **Colour printer, B&W job** | **Comes out grey — this is the one that failed in the field** | PARTIAL — passed on two printers after the grayscale fix; not re-tested since |
| 3 | Colour printer, colour job | Colour as on screen | UNVERIFIED |
| 4 | Portrait (explicit) | Upright regardless of document | UNVERIFIED |
| 5 | Landscape (explicit) | Sideways regardless of document | UNVERIFIED |
| 6 | Auto orientation, portrait source | Upright | UNVERIFIED |
| 7 | Auto orientation, landscape source | Sideways, not letterboxed | UNVERIFIED |
| 8 | Simplex | One side only | UNVERIFIED |
| 9 | Duplex, printer with a duplex unit | Both sides, long edge, reads as a book | UNVERIFIED |
| 10 | Duplex requested, printer without one | Prints simplex **and warns in the log** — the customer paid a duplex rate | UNVERIFIED |
| 11 | A4 | A4 sheets | UNVERIFIED |
| 12 | A3 | A3 sheets, or the printer's default with a warning if no A3 tray | UNVERIFIED |
| 13 | Letter | Letter sheets | UNVERIFIED |
| 14 | Page range `1-3` of a 10-page PDF | Exactly 3 sheets, pages 1–3 | UNVERIFIED |
| 15 | Page range `1-3, 7` | Exactly 4 sheets, in order | UNVERIFIED |
| 16 | Multi-page PDF (50 pages) | 50 sheets, none missing or duplicated | UNVERIFIED |
| 17 | Multiple copies (3) | 3 collated sets, one spool job | UNVERIFIED |
| 18 | Image upload (PNG / JPEG) | One sheet, aspect ratio preserved, not stretched | UNVERIFIED |
| 19 | Office document | **Now refused at upload** — page count cannot be measured. Confirm the customer sees the "export as PDF" message | UNVERIFIED |
| 20 | Separator sheet enabled, backlog present | One separator between batches, not between every job | UNVERIFIED |

## Failure and recovery

| # | Case | What a pass looks like | Verified |
|---|---|---|---|
| 21 | Printer switched off mid-queue | Job returns to the queue or escalates; never silently marked Completed | UNVERIFIED |
| 22 | Printer out of paper | Job fails with a reason a shop can act on | UNVERIFIED |
| 23 | Agent killed mid-print | Job escalates to RequiresShopAction; **not reprinted automatically** — the paper may already be out | UNVERIFIED |
| 24 | Network lost during download | Job retries; checksum mismatch never prints | UNVERIFIED |
| 25 | Cancellation during a long render | Stops between pages rather than finishing the document | UNVERIFIED |
| 26 | PDF over the 2000-page cap | Refused before rendering, with a reason in the log | UNVERIFIED |
| 27 | Document already purged | Job moves to RequiresShopAction; agent is not handed a dead link | UNVERIFIED |
| 28 | Two agents on one printer | Only the claiming device may report on the job | UNVERIFIED |

## What is covered by automated tests instead

These are verified, but in software, against a rasterizer rather than paper.
They are listed so the gap is visible: passing here is necessary and not
sufficient.

| Behaviour | Test |
|---|---|
| B&W rendered grey in the bitmap, not left to the driver | `Prints_black_and_white_as_black_and_white` |
| Empty page areas stay white rather than going black | `Leaves_the_empty_parts_of_a_grey_page_white` |
| Page-range parsing matches the server's billing | `PrintOptionsTests` |
| Page cap refuses an oversized document before rendering | `Refuses_a_document_with_more_pages_than_it_will_print` |
| Agent will not talk to a server that is not ours | `AgentSettingsTests` |

## Why this matters more than it looks

The defect that started this work was case 2: the same mono job printed grey on
one printer and in full colour on the next one along, because asking Windows for
mono sets a DEVMODE flag that drivers are free to ignore — and many do. It was
found by a shop owner watching a printer, not by any test, and it had been
charging customers the mono rate for colour prints.

The fix renders the page grey before the driver sees it, which is
driver-independent by construction. But "by construction" is an argument, and
this matrix is where arguments get checked against paper. Until the Verified
column has entries, PrintOk supports the printers it has been tried on and no
others.
