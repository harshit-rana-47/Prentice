"use client";

import { useParams } from "next/navigation";
import { TaskScreen } from "@/components/task-screen";

export default function TaskPage() {
  const params = useParams<{ id: string }>();
  return <TaskScreen taskId={params.id} />;
}
