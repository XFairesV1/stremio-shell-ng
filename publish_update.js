#!/usr/bin/env node

// Publishes a StremDoBem release to this fork's own update feed.
//
// Upstream's generate_descriptor.js uploads to Stremio's S3 bucket and serves
// the descriptors from dl.strem.io. This fork has no S3: the installer becomes
// a GitHub release asset, and the two JSON documents the shell's updater reads
// (see src/stremio_app/updater.rs) live on the `updates` branch of this repo,
// served raw by raw.githubusercontent.com — the URL baked into UPDATE_FEED.
//
// Feed layout (one pair of documents per arch and channel):
//
//   latest_x64.json      -> { version, versionDesc }   (the "check" document)
//   v5.0.25_x64.json     -> { version, files: [...] }  (the descriptor)
//   rc_x64.json          -> same as latest, RC channel (--rc)
//
// Usage:
//   node publish_update.js --setup ../StremDoBemSetup-v5.0.25_x64.exe
//   node publish_update.js --setup <path> --arch arm64 --rc
//   node publish_update.js --setup <path> --dry-run

const { execFileSync } = require("child_process");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = "XFairesV1/stremio-shell-ng";
const UPDATES_BRANCH = "updates";
// Must match UPDATE_FEED in src/stremio_app/constants.rs
const FEED_URL = `https://raw.githubusercontent.com/${REPO}/${UPDATES_BRANCH}/`;
const RELEASE_URL = `https://github.com/${REPO}/releases/download/`;
const ARCHS = ["x64", "arm64"];
const VERSION_REGEX = /^v(\d+\.\d+\.\d+)$/;

const supportedArguments = Object.freeze({
    setup: {
        description:
            "Path to the built installer (StremDoBemSetup-vX.Y.Z_<arch>.exe). Required.",
        parse: (value) => value || undefined,
    },
    tag: {
        description:
            "Release tag (vX.Y.Z). Defaults to v + the version in Cargo.toml.",
        parse: (value) => (value.match(VERSION_REGEX) ? value : undefined),
    },
    arch: {
        description: `Architecture of the installer. Defaults to the _<arch> suffix of the setup file name. One of: ${ARCHS.join(", ")}`,
        parse: (value) => (ARCHS.includes(value) ? value : undefined),
    },
    rc: {
        description:
            "Publish to the release-candidate channel (only builds started with --release-candidate will see it).",
        default: false,
        parse: parseBooleanArgument,
    },
    dry_run: {
        description:
            "Print what would be published without creating the release or pushing the feed.",
        default: false,
        parse: parseBooleanArgument,
    },
    help: {
        description: "Print this help message",
        parse: () => {
            usage();
            process.exit(0);
        },
    },
});

function parseBooleanArgument(value) {
    // An empty string is truthy here, so --rc and --rc= both mean true.
    return ["false", "0", "no", "off"].includes(value.toLowerCase())
        ? false
        : true;
}

function usage() {
    console.log(`Usage: ${path.basename(process.argv[1])} --setup <file> [options]`);
    console.log("Options:");
    Object.keys(supportedArguments).forEach((key) => {
        const def = supportedArguments[key].default;
        console.log(
            `  --${key.replace(/_/g, "-")}${typeof def !== "undefined" ? ` [default: ${def}]` : ""}`
        );
        console.log(`    ${supportedArguments[key].description}`);
    });
}

function parseArguments() {
    const args = Object.keys(supportedArguments).reduce((acc, key) => {
        if (typeof supportedArguments[key].default !== "undefined")
            acc[key] = supportedArguments[key].default;
        return acc;
    }, {});
    try {
        for (let i = 2; i < process.argv.length; i++) {
            const arg = process.argv[i];
            if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
            if (arg.length === 2) break;
            const eq_position = arg.indexOf("=");
            const name_end = eq_position === -1 ? arg.length : eq_position;
            const name = arg.slice(2, name_end).replace(/-/g, "_");
            if (!supportedArguments[name])
                throw new Error(`Unsupported argument ${arg}`);
            // Support both --name=value and --name value
            let raw = arg.slice(name_end + 1);
            if (eq_position === -1 && typeof supportedArguments[name].default === "undefined") {
                raw = process.argv[++i] || "";
            }
            const value = supportedArguments[name].parse(raw);
            if (typeof value === "undefined")
                throw new Error(`Invalid value for argument --${name.replace(/_/g, "-")}`);
            args[name] = value;
        }
    } catch (e) {
        console.error(e.message);
        usage();
        process.exit(1);
    }
    return args;
}

const run = (cmd, cmdArgs, opts = {}) =>
    execFileSync(cmd, cmdArgs, { encoding: "utf8", ...opts });

const git = (...gitArgs) => run("git", gitArgs).trim();

function cargoVersion() {
    const toml = fs.readFileSync(path.join(__dirname, "Cargo.toml"), "utf8");
    const version = (toml.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
    if (!version) throw new Error("Could not read the version from Cargo.toml");
    return version;
}

function sha256(file) {
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(file));
    return hash.digest("hex");
}

// The updater matches files by `os`, so the descriptor for an arch holds only
// that arch's installer (upstream splits by arch the same way).
function buildDocuments({ tag, version, arch, setupName, checksum }) {
    const descriptorName = `${tag}_${arch}.json`;
    const descriptor = {
        version,
        tag,
        arch,
        released: new Date().toISOString(),
        files: [
            {
                name: setupName,
                url: `${RELEASE_URL}${tag}/${setupName}`,
                checksum,
                os: "windows",
            },
        ],
    };
    // What the shell fetches first; `versionDesc` must resolve to the above.
    const check = {
        version,
        versionDesc: `${FEED_URL}${descriptorName}`,
    };
    return { descriptorName, descriptor, check };
}

// Publishes the feed by committing to the `updates` branch in a throwaway
// worktree, so the checkout the release was built from is never touched.
function pushFeed(files, tag) {
    const repoRoot = git("rev-parse", "--show-toplevel");
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stremdobem-updates-"));
    const branchExists = () => {
        try {
            git("rev-parse", "--verify", `refs/remotes/origin/${UPDATES_BRANCH}`);
            return true;
        } catch {
            return false;
        }
    };

    try {
        run("git", ["fetch", "origin", UPDATES_BRANCH], { cwd: repoRoot, stdio: "ignore" });
    } catch {
        // Expected the first time: the branch does not exist on the remote yet.
    }
    if (branchExists()) {
        git("worktree", "add", "--force", worktree, "-B", UPDATES_BRANCH, `origin/${UPDATES_BRANCH}`);
    } else {
        console.log(`Branch ${UPDATES_BRANCH} does not exist yet, creating it`);
        git("worktree", "add", "--detach", worktree);
        run("git", ["checkout", "--orphan", UPDATES_BRANCH], { cwd: worktree });
        run("git", ["rm", "-rf", "--quiet", "."], { cwd: worktree });
    }

    try {
        for (const [name, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(worktree, name), JSON.stringify(content, null, 2) + "\n");
            run("git", ["add", name], { cwd: worktree });
        }
        const status = run("git", ["status", "--porcelain"], { cwd: worktree }).trim();
        if (!status) {
            console.log("The feed is already up to date, nothing to push");
            return;
        }
        run("git", ["commit", "-m", `Update feed: ${tag}`], { cwd: worktree, stdio: "inherit" });
        run("git", ["push", "origin", UPDATES_BRANCH], { cwd: worktree, stdio: "inherit" });
    } finally {
        git("worktree", "remove", "--force", worktree);
    }
}

function releaseExists(tag) {
    try {
        run("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function main() {
    const args = parseArguments();
    if (!args.setup) {
        console.error("Missing --setup");
        usage();
        process.exit(1);
    }
    if (!fs.existsSync(args.setup)) throw new Error(`No such file: ${args.setup}`);

    const setupName = path.basename(args.setup);
    const arch =
        args.arch || ARCHS.find((a) => path.basename(setupName, ".exe").endsWith(`_${a}`));
    if (!arch)
        throw new Error(
            `Cannot tell the architecture from ${setupName}; pass --arch (${ARCHS.join("|")})`
        );

    const version = cargoVersion();
    const tag = args.tag || `v${version}`;
    if (tag !== `v${version}`)
        throw new Error(
            `Tag ${tag} does not match the version in Cargo.toml (v${version}). ` +
                "Run `node stremiover.js update <version>` first."
        );
    // The shell only offers an update when the feed's version is strictly
    // greater than the running build's, so a stale installer is a silent no-op.
    if (!setupName.includes(version))
        console.warn(
            `WARNING: ${setupName} does not carry the version ${version} in its name — ` +
                "is it the installer built from this checkout?"
        );

    const checksum = sha256(args.setup);
    const { descriptorName, descriptor, check } = buildDocuments({
        tag,
        version,
        arch,
        setupName,
        checksum,
    });
    const checkName = `${args.rc ? "rc" : "latest"}_${arch}.json`;

    console.log(`Publishing ${setupName} as ${tag} (${arch}, ${args.rc ? "rc" : "stable"})`);
    console.log(`sha256: ${checksum}`);
    console.log(`${checkName}:\n${JSON.stringify(check, null, 2)}`);
    console.log(`${descriptorName}:\n${JSON.stringify(descriptor, null, 2)}`);

    if (args.dry_run) {
        console.log("Dry run: not creating the release, not pushing the feed");
        return;
    }

    if (releaseExists(tag)) {
        console.log(`Release ${tag} exists, uploading the installer to it`);
        run("gh", ["release", "upload", tag, args.setup, "--clobber", "--repo", REPO], {
            stdio: "inherit",
        });
    } else {
        console.log(`Creating release ${tag}`);
        run(
            "gh",
            [
                "release",
                "create",
                tag,
                args.setup,
                "--repo",
                REPO,
                "--title",
                `StremDoBem ${tag}`,
                "--notes",
                `StremDoBem ${tag} (${arch})`,
                ...(args.rc ? ["--prerelease"] : []),
            ],
            { stdio: "inherit" }
        );
    }

    // Only after the asset is downloadable, so the feed never points at a 404.
    pushFeed({ [descriptorName]: descriptor, [checkName]: check }, tag);
    console.log(
        `\nDone. Installed builds older than ${version} will offer the update within ` +
            "12h (UPDATE_INTERVAL), or on the next app start."
    );
}

try {
    main();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}
