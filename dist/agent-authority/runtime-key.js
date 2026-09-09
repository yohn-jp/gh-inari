/**
 * Local Runtime Authority key management.
 *
 * This module owns only the local Ed25519 delegation key. It deliberately
 * does not create, write, or register a Runtime Authority trust record and it
 * has no GitHub/App transport. The public key returned here is suitable for a
 * #367 Runtime Authority record; repository trust remains a separate governed
 * operation owned by later work.
 */
import { closeSync, constants as fsConstants, fstatSync, fchmodSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, fsyncSync, lstatSync, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { canonicalJsonString } from "./codec.js";
import { assertEd25519PublicJwk } from "./ed25519-jwk.js";
/** PKCS#8 PEM is compact, standard, and contains no Runtime metadata or trust state. */
export const RUNTIME_PRIVATE_KEY_FILE_FORMAT = "PKCS#8-PEM";
/** A malformed or unsafe key file must not be allowed to consume unbounded local input. */
export const MAX_RUNTIME_PRIVATE_KEY_FILE_BYTES = 16 * 1024;
/** Safe, non-secret diagnostics for local key-management failures. */
export class RuntimeAuthorityKeyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "RuntimeAuthorityKeyError";
        this.code = code;
    }
}
const PRIVATE_KEY_FILE_MODE = 0o600;
const PRIVATE_KEY_DIRECTORY_MODE = 0o700;
const PRIVATE_KEY_PUBLIC_MODE_MASK = 0o077;
const PRIVATE_KEY_EXECUTE_MODE_MASK = 0o111;
const PRIVATE_KEY_READ_MODE = 0o400;
const PRIVATE_KEY_ANCESTOR_WRITE_MODE_MASK = 0o022;
const PRIVATE_KEY_STICKY_MODE = 0o1000;
function isKeyPair(value) {
    return typeof value === "object" && value !== null && "privateKey" in value && "publicKey" in value;
}
function safeKeyError(code, message) {
    return new RuntimeAuthorityKeyError(code, message);
}
function assertPrivateEd25519Key(key) {
    if (typeof key !== "object" || key === null || key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY", "Runtime Authority private key must be an Ed25519 private key.");
    }
}
function publicJwkFromKey(key) {
    try {
        const publicKey = key.type === "private" ? createPublicKey(key) : key;
        if (publicKey.asymmetricKeyType !== "ed25519") {
            throw new TypeError("not Ed25519");
        }
        const exported = publicKey.export({ format: "jwk" });
        // Project only the public members. In particular, a private JWK `d` value
        // can never cross this boundary even if a caller supplies a nonstandard
        // KeyObject implementation.
        return assertEd25519PublicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x }, "$.publicKey");
    }
    catch (error) {
        if (error instanceof RuntimeAuthorityKeyError)
            throw error;
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY", "Runtime Authority key did not contain a valid Ed25519 public key.");
    }
}
function pairFromPrivateKey(privateKey) {
    assertPrivateEd25519Key(privateKey);
    const publicKey = createPublicKey(privateKey);
    const publicKeyJwk = publicJwkFromKey(privateKey);
    return Object.freeze({ privateKey, publicKey, publicKeyJwk });
}
/** Generate an Ed25519 Runtime keypair entirely in local process memory. */
export function generateRuntimeAuthorityKeyPair() {
    try {
        const { privateKey } = generateKeyPairSync("ed25519");
        return pairFromPrivateKey(privateKey);
    }
    catch {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY", "Unable to generate an Ed25519 Runtime keypair.");
    }
}
/** Return only the public JWK, whether the input is a public or private KeyObject or a generated pair. */
export function exportRuntimeAuthorityPublicKey(key) {
    if (isKeyPair(key))
        return key.publicKeyJwk;
    return publicJwkFromKey(key);
}
/** Deterministic public-key JSON for embedding as #367's Runtime Authority `key` value. */
export function canonicalRuntimeAuthorityPublicKeyJson(key) {
    const publicKey = typeof key === "object" && key !== null && "kty" in key
        ? assertEd25519PublicJwk(key, "$.publicKey")
        : exportRuntimeAuthorityPublicKey(key);
    return canonicalJsonString(publicKey);
}
function privateKeyPem(key) {
    assertPrivateEd25519Key(key);
    try {
        const exported = key.export({ format: "pem", type: "pkcs8" });
        if (typeof exported !== "string")
            throw new TypeError("unexpected key encoding");
        return exported;
    }
    catch (error) {
        if (error instanceof RuntimeAuthorityKeyError)
            throw error;
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY", "Unable to encode the Runtime Authority private key.");
    }
}
function currentUserId() {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function isOwner(stat) {
    const userId = currentUserId();
    return userId === undefined || stat.uid === userId;
}
function assertSecureDirectoryStat(stat) {
    const mode = stat.mode & 0o777;
    if (!stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !isOwner(stat) ||
        (mode & PRIVATE_KEY_PUBLIC_MODE_MASK) !== 0o000 ||
        (mode & 0o700) !== 0o700) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority key directory is not private.");
    }
}
/**
 * A pre-existing ancestor may be a system directory (for example `/home` or
 * `/tmp`) and therefore need not be private. It must still be a stable,
 * non-writable traversal boundary. Sticky directories are safe bases because
 * their entries cannot be removed by an unrelated user.
 */
function assertSafeAncestorDirectoryStat(stat) {
    const mode = stat.mode & 0o7777;
    const userId = currentUserId();
    const trustedOwner = userId === undefined || stat.uid === userId || stat.uid === 0;
    const writableByOtherUsers = (mode & PRIVATE_KEY_ANCESTOR_WRITE_MODE_MASK) !== 0;
    if (!stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !trustedOwner ||
        (writableByOtherUsers && (mode & PRIVATE_KEY_STICKY_MODE) === 0)) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority key path contains an unsafe ancestor directory.");
    }
}
function noFollowFlag() {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "This platform cannot safely reject Runtime key symlinks.");
    }
    return fsConstants.O_NOFOLLOW;
}
function descriptorRoot() {
    if (process.platform === "linux")
        return "/proc/self/fd";
    if (process.platform === "darwin" || process.platform === "freebsd")
        return "/dev/fd";
    return undefined;
}
function descriptorPath(fd, child) {
    const root = descriptorRoot();
    if (root === undefined)
        return undefined;
    return child === undefined ? path.join(root, String(fd)) : path.join(root, String(fd), child);
}
function requiredDescriptorPath(fd, child) {
    const result = descriptorPath(fd, child);
    if (result === undefined) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "This platform cannot safely anchor Runtime key paths to a directory descriptor.");
    }
    return result;
}
function directoryOpenFlags(noFollow) {
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    return fsConstants.O_RDONLY | noFollow | directoryFlag;
}
function closeQuietly(fd) {
    if (fd === undefined)
        return;
    try {
        closeSync(fd);
    }
    catch {
        // Preserve the original fail-closed diagnostic.
    }
}
function openAndValidateAncestorDirectory(directoryPath, noFollow) {
    let fd;
    try {
        // This opens an existing directory only; O_DIRECTORY|O_NOFOLLOW plus fstat
        // makes it a stable ancestor descriptor.
        // lgtm [js/insecure-temporary-file]
        fd = openSync(directoryPath, directoryOpenFlags(noFollow));
    }
    catch {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority key path contains an unsafe ancestor directory.");
    }
    try {
        assertSafeAncestorDirectoryStat(fstatSync(fd));
        return fd;
    }
    catch (error) {
        closeQuietly(fd);
        throw error;
    }
}
function openRootDirectory(root, noFollow) {
    let fd;
    try {
        fd = openSync(root, directoryOpenFlags(noFollow));
    }
    catch {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority key path contains an unsafe ancestor directory.");
    }
    try {
        assertSafeAncestorDirectoryStat(fstatSync(fd));
        return fd;
    }
    catch (error) {
        closeQuietly(fd);
        throw error;
    }
}
function openSecureKeyDirectory(directory, createMissing) {
    const targetDirectory = path.resolve(directory);
    const root = path.parse(targetDirectory).root;
    const noFollow = noFollowFlag();
    let current = {
        fd: openRootDirectory(root, noFollow),
    };
    const components = path
        .relative(root, targetDirectory)
        .split(path.sep)
        .filter((component) => component.length > 0);
    try {
        for (const component of components) {
            const childPath = requiredDescriptorPath(current.fd, component);
            let childFd;
            try {
                childFd = openAndValidateAncestorDirectory(childPath, noFollow);
            }
            catch (error) {
                if (!createMissing ||
                    (error instanceof RuntimeAuthorityKeyError && error.code !== "RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE")) {
                    throw error;
                }
                try {
                    mkdirSync(childPath, { mode: PRIVATE_KEY_DIRECTORY_MODE });
                }
                catch (mkdirError) {
                    if (mkdirError.code !== "EEXIST") {
                        throw safeKeyError("RUNTIME_AUTHORITY_KEY_STORAGE_FAILED", "Unable to prepare the Runtime Authority key directory.");
                    }
                }
                childFd = openAndValidateAncestorDirectory(childPath, noFollow);
            }
            closeQuietly(current.fd);
            current = { fd: childFd };
        }
        assertSecureDirectoryStat(fstatSync(current.fd));
        return current;
    }
    catch (error) {
        closeQuietly(current.fd);
        throw error;
    }
}
function stableChildPath(directory, child) {
    return requiredDescriptorPath(directory.fd, child);
}
function targetBasename(filePath) {
    const basename = path.basename(filePath);
    if (basename.length === 0 || basename === "." || basename === "..") {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PATH", "Runtime Authority private key path is required.");
    }
    return basename;
}
function assertSecurePrivateKeyStat(stat) {
    const mode = stat.mode & 0o777;
    if (!stat.isFile() ||
        stat.isSymbolicLink() ||
        !isOwner(stat) ||
        (mode & PRIVATE_KEY_PUBLIC_MODE_MASK) !== 0o000 ||
        (mode & PRIVATE_KEY_EXECUTE_MODE_MASK) !== 0o000 ||
        (mode & PRIVATE_KEY_READ_MODE) === 0) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key file permissions or ownership are unsafe.");
    }
    if (stat.size > MAX_RUNTIME_PRIVATE_KEY_FILE_BYTES) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key file is too large.");
    }
}
function existingPrivateKeyStat(filePath) {
    try {
        return lstatSync(filePath);
    }
    catch (error) {
        const code = error;
        if (code.code === "ENOENT")
            return undefined;
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key path cannot be inspected safely.");
    }
}
function tempPrivateKeyPath(filePath) {
    return `${filePath}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
}
function writePrivateKey(fd, pem) {
    writeSync(fd, pem, undefined, "utf8");
    fchmodSync(fd, PRIVATE_KEY_FILE_MODE);
    fsyncSync(fd);
}
/**
 * Persist only the Runtime private key in a restrictive local secret file.
 * This function never writes a Runtime Authority record or any repository
 * path. Replacement is explicit and uses an atomic same-directory rename.
 */
export function persistRuntimeAuthorityPrivateKey(filePath, key, options = {}) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PATH", "Runtime Authority private key path is required.");
    }
    const targetPath = path.resolve(filePath);
    const pem = privateKeyPem(key);
    const parentDirectory = openSecureKeyDirectory(path.dirname(targetPath), true);
    const targetName = targetBasename(targetPath);
    const stableTargetPath = stableChildPath(parentDirectory, targetName);
    const noFollow = noFollowFlag();
    try {
        const existing = existingPrivateKeyStat(stableTargetPath);
        if (existing !== undefined) {
            if (existing.isSymbolicLink() || !existing.isFile() || !isOwner(existing)) {
                throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key path is unsafe.");
            }
            if (!options.replace) {
                throw safeKeyError("RUNTIME_AUTHORITY_KEY_EXISTS", "Runtime Authority private key already exists; use explicit replacement.");
            }
            // Never replace a file whose permissions are already unsafe. This avoids
            // turning a compromised path into an apparently trusted replacement path.
            assertSecurePrivateKeyStat(existing);
        }
        if (!options.replace) {
            let fd;
            let created = false;
            try {
                fd = openSync(stableTargetPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_KEY_FILE_MODE);
                created = true;
                writePrivateKey(fd, pem);
                closeSync(fd);
                fd = undefined;
            }
            catch (error) {
                if (error.code === "EEXIST") {
                    const raced = existingPrivateKeyStat(stableTargetPath);
                    if (raced?.isSymbolicLink()) {
                        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key path is unsafe.");
                    }
                    throw safeKeyError("RUNTIME_AUTHORITY_KEY_EXISTS", "Runtime Authority private key already exists; use explicit replacement.");
                }
                throw safeKeyError("RUNTIME_AUTHORITY_KEY_STORAGE_FAILED", "Unable to persist the Runtime Authority private key.");
            }
            finally {
                closeQuietly(fd);
                if (fd !== undefined && created) {
                    try {
                        unlinkSync(stableTargetPath);
                    }
                    catch {
                        // Best-effort cleanup only; no trust or publication occurred.
                    }
                }
            }
            return targetPath;
        }
        const temporaryPath = tempPrivateKeyPath(targetPath);
        const temporaryName = targetBasename(temporaryPath);
        const stableTemporaryPath = stableChildPath(parentDirectory, temporaryName);
        let fd;
        try {
            fd = openSync(stableTemporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, PRIVATE_KEY_FILE_MODE);
            writePrivateKey(fd, pem);
            closeSync(fd);
            fd = undefined;
            renameSync(stableTemporaryPath, stableTargetPath);
            try {
                fsyncSync(parentDirectory.fd);
            }
            catch {
                // The replacement is already atomic; directory fsync is best effort.
            }
        }
        catch {
            closeQuietly(fd);
            try {
                unlinkSync(stableTemporaryPath);
            }
            catch {
                // The temporary path is unique and cleanup failure does not change the
                // fact that the replacement did not receive trust or publication.
            }
            throw safeKeyError("RUNTIME_AUTHORITY_KEY_STORAGE_FAILED", "Unable to replace the Runtime Authority private key.");
        }
        return targetPath;
    }
    finally {
        closeQuietly(parentDirectory.fd);
    }
}
/** Generate a local keypair and persist only its private key. */
export function generateAndPersistRuntimeAuthorityKeyPair(filePath, options = {}) {
    const pair = generateRuntimeAuthorityKeyPair();
    persistRuntimeAuthorityPrivateKey(filePath, pair.privateKey, options);
    return pair;
}
/**
 * Load a local Runtime private key with descriptor-level no-follow and
 * restrictive ownership/mode checks. The returned key remains local process
 * state; no GitHub or repository operation is performed.
 */
export function loadRuntimeAuthorityPrivateKey(filePath) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PATH", "Runtime Authority private key path is required.");
    }
    const noFollow = fsConstants.O_NOFOLLOW;
    const nonBlock = fsConstants.O_NONBLOCK;
    if (typeof noFollow !== "number" || typeof nonBlock !== "number") {
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "This platform cannot safely reject Runtime key symlinks.");
    }
    const targetPath = path.resolve(filePath);
    const parentDirectory = openSecureKeyDirectory(path.dirname(targetPath), false);
    const targetName = targetBasename(targetPath);
    const stableTargetPath = stableChildPath(parentDirectory, targetName);
    let fd;
    try {
        // O_NONBLOCK prevents a hostile FIFO/device path from blocking the
        // runtime before fstat can reject its non-regular file type.
        fd = openSync(stableTargetPath, fsConstants.O_RDONLY | noFollow | nonBlock);
    }
    catch (error) {
        closeQuietly(parentDirectory.fd);
        if (error.code === "ENOENT") {
            throw safeKeyError("RUNTIME_AUTHORITY_KEY_NOT_FOUND", "Runtime Authority private key file was not found.");
        }
        throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key file cannot be opened safely.");
    }
    closeQuietly(parentDirectory.fd);
    try {
        const stat = fstatSync(fd);
        assertSecurePrivateKeyStat(stat);
        const content = Buffer.alloc(MAX_RUNTIME_PRIVATE_KEY_FILE_BYTES + 1);
        let offset = 0;
        while (offset < content.byteLength) {
            const bytesRead = readSync(fd, content, offset, content.byteLength - offset, null);
            offset += bytesRead;
            if (bytesRead === 0)
                break;
        }
        if (offset > MAX_RUNTIME_PRIVATE_KEY_FILE_BYTES) {
            throw safeKeyError("RUNTIME_AUTHORITY_KEY_UNSAFE_STORAGE", "Runtime Authority private key file is too large.");
        }
        const pem = content.subarray(0, offset).toString("utf8");
        try {
            const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
            assertPrivateEd25519Key(privateKey);
            // Derive and validate the public portion before returning so malformed
            // or non-Ed25519 key material cannot enter Runtime signing code.
            publicJwkFromKey(privateKey);
            return privateKey;
        }
        catch (error) {
            if (error instanceof RuntimeAuthorityKeyError)
                throw error;
            throw safeKeyError("RUNTIME_AUTHORITY_KEY_INVALID_PRIVATE_KEY", "Runtime Authority private key file is malformed or not Ed25519.");
        }
    }
    finally {
        try {
            closeSync(fd);
        }
        catch {
            // Do not replace the safe key diagnostic with descriptor cleanup noise.
        }
    }
}
/** Load and derive a complete local keypair without exposing private material in its public projection. */
export function loadRuntimeAuthorityKeyPair(filePath) {
    return pairFromPrivateKey(loadRuntimeAuthorityPrivateKey(filePath));
}
/** Default local secret-file location used by the CLI when no path is supplied. */
export function defaultRuntimeAuthorityPrivateKeyPath() {
    return path.join(os.homedir(), ".config", "inari", "runtime-authority.pem");
}
//# sourceMappingURL=runtime-key.js.map