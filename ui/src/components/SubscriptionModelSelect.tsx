import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { aiSubscriptionsApi, type AiSubscriptionProvider } from "@/api/aiSubscriptions";

/** Model picker listing what the signed-in user's subscription offers (fetched live server-side). */
export function SubscriptionModelSelect(props: {
  provider: AiSubscriptionProvider;
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
  /** Use the issue owner's subscription list instead of mine. */
  issueId?: string;
}) {
  const query = useQuery({
    queryKey: props.issueId
      ? ["ai-subscriptions", "issue", props.issueId, "models", props.provider]
      : ["ai-subscriptions", "my-models", props.provider],
    queryFn: () => (props.issueId ? aiSubscriptionsApi.issueModels(props.issueId) : aiSubscriptionsApi.myModels(props.provider)),
    staleTime: 5 * 60 * 1000,
  });
  const models = query.data ?? [];
  const known = props.value && !models.some((m) => m.id === props.value) ? [{ id: props.value, label: props.value }] : [];
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Model</span>
      <select
        className="h-6 rounded border border-border bg-background px-1.5 text-xs"
        value={props.value ?? ""}
        disabled={props.disabled || query.isLoading}
        onChange={(e) => props.onChange(e.target.value || null)}
      >
        <option value="">Default</option>
        {[...known, ...models].map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {query.isLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
      {query.isError ? <span className="text-xs text-destructive">Couldn't load models</span> : null}
    </div>
  );
}
