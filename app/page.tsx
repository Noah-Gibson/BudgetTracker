import { BudgetShell } from "@/components/budget-shell";

// A fresh CSP nonce is issued by middleware for every document request. The
// document therefore must be rendered at request time so Next can put that
// nonce on its framework-generated inline scripts.
export const dynamic = "force-dynamic";

export default function Home() {
  return <BudgetShell />;
}
