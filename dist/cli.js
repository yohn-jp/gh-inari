import { spawnSync } from "node:child_process";
import { AGENT_INVOCATION_CONTRACT } from "./command-contract.js";
import { runCli as runCoreCli } from "./cli-core.js";
function isDiagnosticRequest(argv) {
    return (argv.some((token) => token === "--diagnose" || token === "--doctor") ||
        argv[0] === "diagnose" ||
        argv[0] === "doctor");
}
function runCanonicalDiagnosticCommand(args) {
    try {
        const result = spawnSync(AGENT_INVOCATION_CONTRACT.canonical, [...args], {
            encoding: "utf8",
            maxBuffer: 64 * 1024,
            timeout: 3_000,
        });
        return {
            status: result.status,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            ...(result.error === undefined ? {} : { error: result.error.message }),
        };
    }
    catch (error) {
        return {
            status: null,
            stdout: "",
            stderr: "",
            error: error instanceof Error ? error.message : "unable to execute inari",
        };
    }
}
function parseVersion(value) {
    const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (match === null)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function versionAtLeast(actual, minimum) {
    const actualParts = parseVersion(actual);
    const minimumParts = parseVersion(minimum);
    if (actualParts === undefined || minimumParts === undefined)
        return false;
    for (let index = 0; index < actualParts.length; index += 1) {
        if (actualParts[index] !== minimumParts[index])
            return (actualParts[index] ?? 0) > (minimumParts[index] ?? 0);
    }
    return true;
}
function detailFrom(result) {
    const detail = (result.error ?? result.stderr).trim().split(/\r?\n/u)[0];
    return detail === "" ? undefined : detail.slice(0, 240);
}
function projectCanonicalRuntime(result, expected) {
    const recovery = AGENT_INVOCATION_CONTRACT.fallback;
    if (result.status === null) {
        const detail = detailFrom(result);
        return {
            invocation: AGENT_INVOCATION_CONTRACT.canonical,
            status: detail?.includes("ENOENT") === true ? "missing" : "unavailable",
            ...(detail === undefined ? {} : { detail }),
            recovery,
        };
    }
    if (result.status !== 0) {
        const detail = detailFrom(result);
        return {
            invocation: AGENT_INVOCATION_CONTRACT.canonical,
            status: "stale",
            ...(detail === undefined ? {} : { detail }),
            recovery,
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout.trim());
    }
    catch {
        return {
            invocation: AGENT_INVOCATION_CONTRACT.canonical,
            status: "stale",
            detail: "the canonical inari executable does not support machine-readable version output",
            recovery,
        };
    }
    if (typeof parsed.version !== "string" ||
        !Array.isArray(parsed.capabilities) ||
        parsed.capabilities.some((capability) => typeof capability !== "string")) {
        return {
            invocation: AGENT_INVOCATION_CONTRACT.canonical,
            status: "stale",
            detail: "the canonical inari executable returned an incompatible version contract",
            recovery,
        };
    }
    const expectedCanonical = typeof expected.invocation?.canonical === "string"
        ? expected.invocation.canonical
        : AGENT_INVOCATION_CONTRACT.canonical;
    const expectedContract = typeof expected.commandContractVersion === "string" ? expected.commandContractVersion : undefined;
    const requiredCapabilities = Array.isArray(expected.requiredCapabilities)
        ? expected.requiredCapabilities.filter((value) => typeof value === "string")
        : [];
    const minimumVersion = typeof expected.minimumVersion === "string" ? expected.minimumVersion : undefined;
    const missingCapabilities = requiredCapabilities.filter((capability) => !parsed.capabilities?.includes(capability));
    const problems = [];
    if (parsed.invocation?.canonical !== expectedCanonical)
        problems.push(`canonical invocation is ${JSON.stringify(parsed.invocation?.canonical ?? "unknown")}, expected ${JSON.stringify(expectedCanonical)}`);
    if (expectedContract !== undefined && parsed.commandContractVersion !== expectedContract)
        problems.push(`command contract is ${parsed.commandContractVersion ?? "unknown"}, expected ${expectedContract}`);
    if (missingCapabilities.length > 0)
        problems.push(`missing capability ${missingCapabilities.join(", ")}`);
    if (minimumVersion !== undefined && !versionAtLeast(parsed.version, minimumVersion))
        problems.push(`version ${parsed.version} is older than required ${minimumVersion}`);
    if (problems.length > 0) {
        return {
            invocation: AGENT_INVOCATION_CONTRACT.canonical,
            status: "stale",
            version: parsed.version,
            capabilities: parsed.capabilities,
            ...(missingCapabilities.length === 0 ? {} : { missingCapabilities }),
            detail: problems.join("; "),
            recovery,
        };
    }
    return {
        invocation: AGENT_INVOCATION_CONTRACT.canonical,
        status: "ready",
        version: parsed.version,
        capabilities: parsed.capabilities,
        recovery,
    };
}
async function runDiagnosticWithCanonicalProbe(argv, dependencies) {
    const execute = dependencies.runCanonicalDiagnosticCommand ?? runCanonicalDiagnosticCommand;
    const canonicalProbe = execute(["--version", "--json"]);
    const jsonArgv = argv.some((token) => token === "--json" || token === "--json=true")
        ? [...argv]
        : [...argv, "--json"];
    const lines = [];
    const originalLog = console.log;
    try {
        console.log = (line) => lines.push(line);
        await runCoreCli(jsonArgv, dependencies);
    }
    finally {
        console.log = originalLog;
    }
    const coreLine = lines.at(-1);
    if (coreLine === undefined)
        return 4;
    const output = JSON.parse(coreLine);
    const canonical = projectCanonicalRuntime(canonicalProbe, output);
    output.canonical = canonical;
    output.ok = canonical.status === "ready";
    const json = argv.some((token) => token === "--json" || token === "--json=true");
    if (json)
        console.log(JSON.stringify(output));
    else {
        console.log(`${String(output.name ?? "gh-inari")} ${String(output.version ?? "unknown")}`);
        if (canonical.status === "ready")
            console.log(`${canonical.invocation}: ready (${canonical.version ?? "unknown version"})`);
        else {
            console.error(`${canonical.invocation}: ${canonical.detail ?? `the canonical runtime is ${canonical.status}`}`);
            console.error(`Action: ${canonical.recovery}`);
        }
        const compatibility = output.compatibility;
        if (compatibility !== undefined && compatibility.status !== "ready") {
            console.error(`${String(compatibility.invocation ?? AGENT_INVOCATION_CONTRACT.compatibility)} (compatibility): ${String(compatibility.detail ?? `the extension is ${String(compatibility.status)}`)}`);
            if (typeof compatibility.recovery === "string")
                console.error(`Action: ${compatibility.recovery}`);
        }
    }
    return canonical.status === "ready" ? 0 : 2;
}
/**
 * Public CLI entrypoint. Diagnostics first prove that the canonical `inari`
 * executable itself is reachable and reports the expected contract; all other
 * behavior remains delegated to the governed CLI core.
 */
export async function runCli(argv, dependencies = {}) {
    if (!isDiagnosticRequest(argv))
        return runCoreCli(argv, dependencies);
    return runDiagnosticWithCanonicalProbe(argv, dependencies);
}
//# sourceMappingURL=cli.js.map