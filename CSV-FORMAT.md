# Contact CSV — accepted format

Download [`contacts-template.csv`](contacts-template.csv) and replace the sample rows,
or export straight from Google Contacts — that export works unchanged.

## The short version

```csv
Name,Mobile Phone
Asha,+91 90000 00001
Sarah,+1 415 555 0123
```

A header row and one phone column are the only hard requirements.

> ## ✅ The one rule that matters
> **Write every number with its country code.** `+91…`, `+1…`, `+44…`, `+971…` —
> spaces, dashes and brackets are all fine, the `+` is optional.
>
> Do that and the rest of this page is trivia. A number that already carries a
> country code is passed through untouched, so nothing can be guessed wrong.
> Numbers *without* one are guessed at, and the guess is India (see below).

## Which columns are read

The parser matches column *headers*, not positions, so extra columns are ignored
and column order does not matter.

| Purpose | Header must match | Examples that work |
|---|---|---|
| Name | contains `First Name`, or **starts with** `Name` | `Name`, `First Name`, `FirstName`, `Name (display)` |
| Mobile | contains `Mobile` | `Mobile Phone`, `Mobile`, `Mobile Phone 1 - Value` |
| Home | contains `Home` | `Home Phone`, `Home Phone 1 - Value` |

- A row with **no matching name column** is still sent — the name becomes `Contact`.
- A row with **no usable phone number** is silently dropped.
- If a row has *both* a mobile and a home number, **both are messaged** — one
  person, two sends, two charges. Delete the home column if you do not want that.
- `Given Name` alone will *not* be picked up (it neither contains `First Name`
  nor starts with `Name`). Google's export includes a plain `Name` column too, so
  its files are fine as-is.

## How phone numbers are cleaned

Every number is reduced to digits, so spaces, `+`, `-`, `(` and `)` are all fine.
Then:

| Input | Rule applied | Sent to Meta as |
|---|---|---|
| `9000000001` | 10 digits → assume India, prefix `91` | `919000000001` |
| `09000000003` | 11 digits starting `0` → drop the `0`, prefix `91` | `919000000003` |
| `+91 90000 00002` | already has a country code | `919000000002` |
| `+39 333 000 0004` | already has a country code | `393330000004` |

Rejected outright, no error shown, just skipped:

- fewer than 7 digits, or a final result outside 11–15 digits
- toll-free prefixes `1800`, `1860`, `1900`

Duplicates are removed by the **cleaned** number, so `9000000001`,
`+91 90000 00002` and `091 90000 0001` collapse to one send. First row wins.

> ### ⚠️ What happens without a country code
> A bare 10-digit number is **assumed to be Indian**. That is a guess, and it is
> wrong for everyone else: a US number written as `4155550123` silently becomes
> `914155550123` and the send fails.
>
> This is exactly why the rule at the top of this page exists. Write
> `+14155550123` and no guess is made. The `91` fallback is a convenience for
> Indian lists that predate this guidance — do not rely on it.

## Limits and gotchas

- **UTF-8** only. Excel's "CSV (Comma delimited)" is fine; "CSV UTF-8" is safer
  for non-Latin names.
- **Commas inside a field break the row**, even when quoted. `"Sharma, Asha"`
  shifts every later column by one. Remove commas from names before exporting.
- Semicolon-separated CSVs (common on European Excel locales) are not parsed.
  Save as comma-separated.
- Blank lines are ignored. There is no row limit, but the whole file is held in
  memory — past ~50k rows, split it.

## Before you upload

1. Everyone in the file must have **opted in** to hear from your business. Meta
   suspends templates over block and report rates, not over volume.
2. Numbers that previously tapped **Stop promotions** are skipped automatically —
   they stay in `opt-outs.json` across uploads and restarts, so re-uploading an
   old list will not re-message them.
3. After uploading, click **View all** to check the parsed name and `+number` for
   every row before you start. What you see there is exactly what will be sent.
