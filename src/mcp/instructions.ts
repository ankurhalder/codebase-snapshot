/**
 * The instructions an MCP client shows its model at handshake.
 *
 * This text is the cheapest documentation the project has: it arrives before the first tool call,
 * in the model's own context, on every client that supports the field. It is therefore about
 * *order* rather than features — an agent that reads a part end to end has already lost the
 * budget this tool exists to protect.
 */
export const SERVER_INSTRUCTIONS = [
  "codebase-snapshot serves this repository as a size-budgeted snapshot, not as a directory walk.",
  "",
  "Work in this order:",
  "1. snapshot_status — is there a snapshot here, and has the tree moved since it was built?",
  "2. snapshot_locate — find which part holds the code you need.",
  "3. snapshot_read — read a window of one file. Never read a part end to end.",
  "4. snapshot_dependents — before changing a file, see what imports it.",
  "5. snapshot_validate — before trusting context that came from an earlier conversation.",
  "",
  "Rules that matter:",
  "- Parts are budgeted, not small: a 12-part snapshot is hundreds of kilobytes. Use snapshot_locate first.",
  "- A file absent from the snapshot has a recorded reason. Ask snapshot_explain, do not assume.",
  "- snapshot_generate is the only tool that writes. It never installs packages and never writes config.",
  "- Paths are relative to the repository root the server was started for, and nothing outside it is readable.",
].join("\n");
