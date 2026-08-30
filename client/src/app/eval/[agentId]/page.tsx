"use client";

import { useParams } from "next/navigation";
import { AgentEvalView } from "./_components/AgentEvalView";

/* Route: /eval/:agentId — one agent's eval history, trend and run comparison. */
export default function AgentEvalPage() {
  const params = useParams<{ agentId: string }>();
  return <AgentEvalView agentId={params.agentId} />;
}
