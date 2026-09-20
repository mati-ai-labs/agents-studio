import type {
  IssueCompletionDeliverySummary,
  IssueCompletionDestination,
} from "@paperclipai/shared";

export function formatCompletionDestinationLabel(destination: IssueCompletionDestination | null | undefined): string {
  if (!destination) return "No delivery";
  if (destination.kind === "slack") return `Slack #${destination.channelName}`;
  return "Configured";
}

export function formatCompletionDeliveryStatusLabel(
  delivery: IssueCompletionDeliverySummary | null | undefined,
): string {
  switch (delivery?.status) {
    case "pending":
      return "Queued";
    case "sending":
      return "Sending";
    case "sent":
      return "Delivered";
    case "failed":
      return "Failed";
    case "superseded":
      return "Superseded";
    default:
      return "Not sent";
  }
}

export function completionDeliveryStatusTone(
  delivery: IssueCompletionDeliverySummary | null | undefined,
): string {
  switch (delivery?.status) {
    case "sent":
      return "bg-green-100 text-green-800";
    case "failed":
      return "bg-red-100 text-red-800";
    case "superseded":
      return "bg-muted text-muted-foreground";
    case "pending":
    case "sending":
      return "bg-blue-100 text-blue-800";
    default:
      return "bg-muted text-muted-foreground";
  }
}
