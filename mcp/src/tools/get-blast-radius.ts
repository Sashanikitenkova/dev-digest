import { BLAST_RADIUS_STUB_MESSAGE } from '../errors.js';
import { ok, type ToolResult } from '../shape.js';

export interface GetBlastRadiusArgs {
  repo: string;
  pr: number;
}

/**
 * APPLICATION ring — `get_blast_radius`, deliberately a **stub**.
 *
 * It is registered so the five-tool shape of the lesson holds; wiring it to the
 * already-working `GET /pulls/:id/blast` is the homework.
 *
 * Two rules this obeys:
 *
 * 1. **Never throw.** A thrown error reads as a bug; a structured result reads
 *    as a roadmap item, and the message names the endpoint to start from.
 * 2. **`isError: false`.** "Not implemented yet" is a known state of a healthy
 *    system, not something the model did wrong. Flagging it as an error teaches
 *    the model to distrust the rest of the server.
 *
 * It makes no API call at all — resolving `repo`/`pr` would spend a (slow) PR
 * sync to produce a fixed message. The arguments are declared so that the tool's
 * signature does not change when the homework lands.
 */
export function getBlastRadius(_args: GetBlastRadiusArgs): ToolResult {
  return ok({ implemented: false, message: BLAST_RADIUS_STUB_MESSAGE });
}
