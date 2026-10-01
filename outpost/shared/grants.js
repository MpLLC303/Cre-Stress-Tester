// Object type -> tools it grants. Shared by the runtime (sidecar/capability.js enforces it)
// and the UI (room terminals display it), so what the station shows is what is enforced.
// Tool names must exist in sidecar/tools/index.js.

export const OBJECT_GRANTS = {
  command_console: ['delegate_task', 'list_tasks', 'read_artifact'],
  status_board: ['read_ledger', 'list_artifacts'],
  research_terminal: ['web_search', 'web_fetch'],
  workbench: ['write_file', 'read_file', 'list_files', 'read_artifact'],
  archive: ['memory_read', 'memory_write', 'list_artifacts'],
  design_station: ['render_svg_design', 'generate_image', 'read_artifact'],
  listing_composer: ['create_listing_draft'],
  publish_gate: ['publish_listing'],
  packager: ['package_deliverable', 'list_artifacts'],
  delivery_gate: ['deliver_order'],
  ledger_terminal: ['read_ledger', 'record_ledger_claim'],
  connector_dock: ['sync_connector'],
};

/** Tools every agent gets regardless of objects (still subject to their own checks). */
export const INTRINSIC_TOOLS = ['handoff'];
