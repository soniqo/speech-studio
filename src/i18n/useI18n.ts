import { messages } from "./messages";
import { useProjectStore } from "../state/projectStore";

export function useI18n() {
  const locale = useProjectStore((s) => s.locale);
  return { locale, messages: messages[locale] };
}
