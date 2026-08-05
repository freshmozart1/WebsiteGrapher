import { clearSession, listSessions } from "../../browser/session.js";
import { EXIT, UsageError } from "../exit.js";

/**
 * A session is saved cookies and a last URL, not a running browser — there is
 * never a browser process to tear down between commands.
 */
export async function sessionCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case "list": {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        console.log("No saved sessions. (No browser is running either — wgraph never leaves one open.)");
        return EXIT.OK;
      }
      for (const s of sessions) {
        console.log(`${s.name}  ${s.currentUrl}  (updated ${s.updatedAt})`);
      }
      return EXIT.OK;
    }
    case "clear": {
      const name = argv[1];
      if (!name) throw new UsageError("wgraph session clear <name>");
      await clearSession(name);
      console.log(`Cleared saved state for "${name}".`);
      return EXIT.OK;
    }
    default:
      throw new UsageError("Expected: wgraph session list | clear <name>");
  }
}
