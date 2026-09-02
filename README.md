<h1 align="center">fastrnm</h1>

<p align="center">
  <strong>Bulk-rename a folder of files into a clean numbered sequence — without ever leaving it half done.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/fastrnm"><img alt="npm version" src="https://img.shields.io/npm/v/fastrnm.svg"></a>
  <img alt="node 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
</p>

```console
$ npx fastrnm ./photos --prefix holiday --pad 3 --dry-run

./photos

  IMG_2931.jpg  →  holiday_001.jpg  ✓
  IMG_2932.jpg  →  holiday_002.jpg  ✓
  IMG_2933.jpg  →  holiday_003.jpg  ✓

3 files. Dry run: nothing has been changed.
```

---

## Why fastrnm

Renaming a hundred files is the kind of task that looks trivial until it goes
wrong halfway through. Most bulk renamers fail on the same handful of points,
and fastrnm exists to cover all of them:

| | |
|---|---|
| **Automatic padding** | 12 files get `01`, 120 files get `001`. Your file manager keeps them in order without you having to think about it. |
| **Natural ordering** | `file2` is numbered before `file10`, not after it. |
| **All-or-nothing** | Every target name is computed and checked *before* the first file is touched. One collision aborts the batch; nothing is renamed. |
| **Real undo** | Each run writes a log. `fastrnm ./photos --undo` puts everything back. |
| **Rollback on failure** | If the filesystem fails mid-run, the changes already applied are reverted before the error is reported. |
| **Cross-platform name checks** | Reserved Windows device names, forbidden characters and trailing dots are rejected up front — even on macOS, because those files end up in a ZIP on someone else's machine. |
| **A non-destructive mode** | `--output` writes the renamed files into another folder and leaves the originals exactly as they were. |
| **No dependencies** | Nothing to audit, nothing to download. `npx` starts instantly. |

## Install

**Nothing to install.** `npx` fetches and runs it on the spot, so a one-off
rename is a single command:

```bash
npx fastrnm ./photos --prefix holiday --dry-run
```

It starts fast because the package has **zero dependencies**: there is nothing
to resolve beyond the tool itself, around 30 kB. Nothing is left behind on your
machine either.

**If you reach for it often**, install it globally and drop the `npx`:

```bash
npm install -g fastrnm
```

```bash
fastrnm ./photos --prefix holiday --dry-run
```

To update or remove a global install later:

```bash
npm update -g fastrnm      # move to the latest version
npm uninstall -g fastrnm   # remove it
```

Requires **Node 18 or newer**. Works on macOS, Linux and Windows.

> **Status: 0.x.** The tool is complete and covered by tests, but the flag
> names may still move as it meets real use. Pin the version if you script
> against it; the behaviour of what is already there will not change silently.

## Quick start

The examples below are written as `fastrnm`. If you did not install it, put
`npx` in front of each one — everything else is identical.

**Preview first — always safe, changes nothing:**

```bash
fastrnm ./photos --prefix holiday --pad 3 --dry-run
```

**Apply it:**

```bash
fastrnm ./photos --prefix holiday --pad 3
```

**Changed your mind:**

```bash
fastrnm ./photos --undo
```

**Keep the originals and write the renamed copies elsewhere:**

```bash
fastrnm ./photos --output ./photos-renamed --prefix holiday --create-dir
```

```
2 files copied.
The originals have not been modified.
Undo with: fastrnm ./photos-renamed --undo
```

## Usage

```
fastrnm [folder] [options]
```

The folder can be relative (`./photos`), absolute (`/Users/me/photos`) or
home-relative (`~/photos`). If you omit it, fastrnm uses the current folder —
and in that case it **always asks for confirmation, even with `--yes`**.
Renaming the folder you happen to be standing in is the most expensive mistake
this tool could make.

### Source and destination

Where the files come from, and where the renamed ones end up. This is the one
choice worth making deliberately: by default the files are renamed where they
are, and with `--output` they are written into another folder while the
originals stay exactly as they were.

| Option | Description | Default |
|---|---|---|
| `[folder]` | Folder whose files will be renamed | current folder |
| `--dir <path>` | Explicit alternative to the positional argument | — |
| `-o, --output <path>` | Copy the renamed files here, leaving the originals untouched | rename in place |
| `--move` | With `--output`: move instead of copy | copy |
| `--create-dir` | Create the destination folder if it does not exist | ask |
| `--flatten` | With `--recursive` and `--output`: write everything into one flat folder | keep structure |

### Naming

What each new name is built from. The parts are always assembled in the same
order and joined by the separator, and the original extension is carried over
untouched:

    prefix · original name · number · suffix · .extension

Only the parts you ask for appear, so with no options at all a file simply
becomes `1.jpg`:

```bash
fastrnm ./photos --prefix holiday --keep-name --suffix raw --pad 3
# beach.jpg  ->  holiday_beach_001_raw.jpg
```

| Option | Description | Default |
|---|---|---|
| `--prefix <text>` | Text before the number (`holiday_1.jpg`) | none |
| `--suffix <text>` | Text after the number (`holiday_1_raw.jpg`) | none |
| `--start <n>` | First number of the sequence | `1` |
| `--step <n>` | Increment between numbers (`--step 2` → 1, 3, 5…) | `1` |
| `--pad <n>` | Leading zeros (`--pad 3` → `001`) | automatic |
| `--separator <char>` | Separator between the parts | `_` |
| `--random` | Random names instead of a sequence (`a7f3k9x2.jpg`) | off |
| `--random-length <n>` | Characters per random name | `8` |
| `--keep-name` | Keep the original name before the number (`holiday_01.jpg`) | off |

Automatic padding is derived from the highest number the run will reach, so
`--start` and `--step` are taken into account too. Pass `--pad 0` for no
padding at all, or `--separator ""` to glue the parts together (`img07.png`).

`--random` replaces the sequence with an opaque token drawn from `a-z0-9`,
useful when the current names give away more than you want to share. Tokens are
lowercase only, because macOS and Windows compare filenames without case and a
mixed alphabet would let two names collide at random on those platforms. They
are drawn from `crypto`, guaranteed unique within the batch, and combine with
`--prefix` and `--suffix` as usual. Since random names carry no order, `--random`
refuses `--start`, `--step` and `--pad` rather than ignoring them.

`--keep-name` numbers the files without throwing their names away
(`holiday.jpg` becomes `holiday_01.jpg`), for when the names are already good
and all that is missing is the order.

### Order

Which file gets number 1 and which gets the last one. The numbering follows
this order, so it is what gives the sequence its meaning — by capture date for
photos, by size for a report, alphabetically for everything else. It changes
nothing about which files are renamed, only the order they are numbered in.

| Option | Description |
|---|---|
| `--sort name` | Natural alphabetical order — **default** |
| `--sort date` | Modification date, oldest first |
| `--sort created` | Creation date, oldest first |
| `--sort exif` | Capture date read from the photo, oldest first |
| `--sort size` | File size, smallest first |
| `--reverse` | Reverse the chosen order |
| `--interactive` | Print the numbered list and let you reorder it before applying |

`--sort exif` reads the capture date out of the file instead of trusting the
filesystem. This matters more than it sounds: copying photos off a camera card
rewrites every modification date, so `--sort date` ends up ordering them by
when you copied them rather than when you took them. Files with no readable
capture date fall back to their modification date, and fastrnm says how many
did. Only JPEG is understood — HEIC and camera RAW formats are not parsed.

### Filters

Which files take part in the run at all. Anything left out is not renamed, not
counted and not touched — and when the filters leave nothing behind, fastrnm
says how many files were skipped and for what reason.

| Option | Description |
|---|---|
| `--ext jpg,png` | Only these extensions |
| `--match "IMG_*"` | Glob pattern, or a regular expression when wrapped in slashes: `--match "/^DSC\d+/"` |
| `--exclude "*.tmp"` | Skip files matching this pattern |
| `-r, --recursive` | Include subfolders |
| `--restart-per-folder` | With `--recursive`: restart the numbering in every folder |
| `--include-hidden` | Include hidden files (skipped by default) |

Folders are never renamed — only files. The original extension is always
preserved, compound ones included: `backup.tar.gz` becomes `f_1.tar.gz`, not
`f_1.gz`.

### Safety and output

How much fastrnm asks before it acts, and in what form it reports what it did.
The defaults lean towards asking: previewing costs nothing, overwriting is
never implicit, and every applied run leaves a way back.

| Option | Description |
|---|---|
| `--dry-run` | Print the `current → new` table without touching anything |
| `-y, --yes` | Skip the confirmation prompt (for scripts) |
| `--undo` | Revert the last run of that folder |
| `--force` | Allow overwriting on collision — never the default |
| `--json` | Structured output for scripting |
| `--no-color` | Disable colors (`NO_COLOR` is honoured too) |
| `-h, --help` | Show the help |
| `-v, --version` | Show the version |

### Combinations that are refused

Some flags only mean something together, and a few contradict each other. Rather
than guessing, fastrnm stops and says so:

| Combination | Why |
|---|---|
| `--move` without `--output` | There is nowhere to move the files to |
| `--flatten` without `--output` and `--recursive` | Flattening only applies when writing a tree somewhere else |
| `--restart-per-folder` without `--recursive` | There is only one folder to number |
| `--restart-per-folder` with `--flatten` | Restarting the count in every folder and then merging them guarantees duplicate names |
| `--random` with `--start`, `--step` or `--pad` | Random names have no sequence; use `--random-length` |
| `--random-length` without `--random` | Nothing to set the length of |

## Examples

Number photos by the date they were actually taken:

```bash
fastrnm ./photos --sort exif --ext jpg --prefix trip
```

Add numbering to files whose names you want to keep:

```bash
fastrnm ./invoices --keep-name --sort date
```

Renumber a whole album tree, restarting on every folder:

```bash
fastrnm ./albums --recursive --restart-per-folder --prefix track --pad 2
```

Flatten a nested export into a single numbered folder, without destroying the
original tree:

```bash
fastrnm ./export --recursive --flatten --output ./flat --prefix page --create-dir
```

Continue an existing sequence (the first 40 files are already named):

```bash
fastrnm ./new-batch --prefix holiday --start 41 --pad 3
```

Anonymise a folder of scans into a separate one, leaving the originals alone:

```bash
fastrnm ./scans --random --output ./anonymous --create-dir
```

Rename everything except the temporary files, and pick the order by hand:

```bash
fastrnm ./scans --exclude "*.tmp" --interactive --prefix scan
```

## How it works

The rename map is built as a pure, in-memory transformation before any syscall
touches your files. That is what makes the safety guarantees possible:

1. **Validate** the prefix, suffix, separator and numbers. Bad input never
   reaches the filesystem.
2. **Collect** the candidate files, applying the filters.
3. **Sort** them with the chosen strategy.
4. **Plan** every `current → new` pair — no I/O at all, which is why
   `--dry-run` is simply "build the plan and stop".
5. **Detect collisions**: duplicated targets inside the batch, targets that
   already exist on disk, and names that are illegal on some platform.
6. **Apply**, or roll back everything if a single operation fails.

Two details worth knowing:

- **Swaps are handled.** `a.jpg → b.jpg` together with `b.jpg → a.jpg` is not a
  collision; it is a rotation, applied through temporary names in two phases.
- **Case-insensitive filesystems are respected.** On macOS and Windows,
  `Photo.jpg` and `photo.jpg` are treated as the same target and reported as a
  collision instead of silently overwriting one another.

Before a copy or a cross-device move, fastrnm also sums the total size and
checks it fits in the destination — failing halfway through 8 GB of photos is
not acceptable behaviour. Copies keep the original modification timestamps, so
date-based sorting still works afterwards.

## Undo

Every applied run writes a `.fastrnm-log.json` file listing the exact
operations. `--undo` reads it, reverts them and removes the log.

| Mode | Where the log lives | What `--undo` does |
|---|---|---|
| In place | source folder | Renames the files back |
| `--output` (copy) | destination folder | Deletes the copies; the originals were never touched |
| `--move` | source folder | Moves the files back with their original names |

Only the last run is kept, so running fastrnm twice on the same folder
replaces the log and the names from the first run stop being recoverable. When
that is about to happen, fastrnm says so before doing it:

```
Warning: this folder has a rename from 02/09/2026, 18:40 that has not been
undone. Running again replaces the undo log and the original names
(IMG_2931.jpg, IMG_2932.jpg, ...) become unrecoverable.
```

It is a warning, not a wall: the run continues after the usual confirmation,
and `--yes` still skips the prompt. The warning is silent when there is nothing
to lose — no previous run, or one whose files have since moved on. With
`--json` the same information comes back as a `pendingUndo` field.

The log matters most with `--random`: an opaque name says nothing about where
it came from, so `--undo` is the only way back. Copy into a separate folder
with `--output` if you want a second safety net.

Undoing a copy deletes files, which is more destructive than renaming them, so
it always states exactly how many files are about to be removed. Files that
were renamed, moved or deleted after the run are reported and skipped instead
of being guessed at.

## Scripting

`--json` prints a structured payload instead of the table. It requires `--yes`
to apply anything, so a JSON run can never be blocked on an invisible prompt:

```bash
fastrnm ./photos --prefix holiday --json --dry-run
```

```json
{
  "ok": true,
  "mode": "rename",
  "dryRun": true,
  "source": "/Users/me/photos",
  "destination": null,
  "padding": 3,
  "pendingUndo": null,
  "operations": [
    { "from": "/Users/me/photos/IMG_2931.jpg", "to": "/Users/me/photos/holiday_001.jpg", "error": null }
  ],
  "applied": false
}
```

On a collision the same shape comes back with `"ok": false` and a per-operation
`error`, and the exit code is `1`. Every other failure — a missing folder, a
bad flag, a filesystem error — is reported as JSON too, so a script never has
to parse prose:

```json
{ "ok": false, "applied": false, "error": "the folder \"./nope\" does not exist.", "hint": "Check the path and try again." }
```

**Exit codes:** `0` success or nothing to do · `1` validation error, collision
or failure.

## Notes and limitations

- **Symbolic links are skipped**, and reported so they do not vanish silently.
  Only regular files are renamed.
- **Hidden files are skipped** unless you pass `--include-hidden`; with
  `--recursive`, hidden folders are skipped too.
- **The log file is never renamed.** `.fastrnm-log.json` is excluded from every
  scan.
- **A destination inside the source is rejected** when combined with
  `--recursive`, since the tool would otherwise keep processing its own output.
- **`--output` pointing at the source folder** is treated as a plain in-place
  rename, not as a copy — no duplicated files.
- **Non-interactive shells** (CI, pipes) refuse to touch anything without
  `--yes`, rather than assuming consent.
- **Runs of more than 200 files show progress** while they work, so a long batch
  never looks like a hang. Cancelling a prompt with Ctrl+D leaves everything
  untouched.
- **A killed run can leave `.fastrnm-tmp-*` files behind.** Swaps are applied
  through temporary names, so a process killed between the two phases leaves
  those hidden files holding your data — intact, but under a meaningless name.
  fastrnm never renames them again; delete or rename them by hand.

### On Windows

Two behaviours differ there, and neither can be fixed without native code:

- **"Hidden" means a leading dot, not the Windows attribute.** A file marked
  hidden through Explorer has an ordinary name, so fastrnm treats it as a normal
  file and renames it. `fs.Stats` does not expose Windows file attributes.
- **A file open in another program cannot be renamed** and fails with `EBUSY`,
  where macOS and Linux would rename it happily. The batch is rolled back and
  nothing is left half done, but closing the photo viewer first avoids the trip.
- **When nothing matches**, the error says what was skipped and why (`4 not
  matching --ext`, `2 subfolders (use --recursive)`) instead of claiming the
  folder is empty.

## Contributing

Issues and pull requests are welcome. The project is deliberately small:

```
index.js              entrypoint: argument parsing and orchestration
src/validate.js       prefix, suffix, separator and number validation
src/paths.js          source and destination resolution, permissions, disk space
src/collect.js        directory scanning and filtering
src/sort.js           sorting strategies
src/plan.js           the current → new map (pure, no I/O)
src/random.js         random name tokens
src/exif.js           minimal JPEG EXIF reader (capture date)
src/collisions.js     conflict detection
src/apply.js          rename / copy / move, two-phase renaming, rollback
src/undo.js           reverting from the log
src/output.js         terminal formatting
test/                 node:test suite
```

```bash
npm test
```

Two conventions keep the tool trustworthy, so please preserve them:

- **No runtime dependencies.** Everything is built on the Node standard
  library; every dependency is download time on every `npx`.
- **`src/plan.js` never touches the disk.** Keeping the rename map pure is what
  makes `--dry-run` honest and the test suite fast.

New behaviour should come with a test. The suite covers validation, planning,
collisions and the CLI end to end.

## License

[MIT](LICENSE)
