import type { LucideIcon } from "lucide-react";
import { Brain, BriefcaseBusiness, CalendarClock, Folder, PlugZap, Settings, Sparkles } from "lucide-react";

export type PrimaryRoute = {
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const primaryRoutes: PrimaryRoute[] = [
  { path: "/", label: "工作", description: "会话、工具执行和任务产物", icon: BriefcaseBusiness },
  { path: "/files", label: "文件", description: "查看 U 盘工作区文件", icon: Folder },
  { path: "/memory", label: "记忆", description: "查看 Agent 长期与项目记忆", icon: Brain },
  { path: "/capabilities", label: "能力", description: "模型、技能、插件和 MCP", icon: Sparkles },
  { path: "/connections", label: "连接", description: "渠道和第三方服务", icon: PlugZap },
  { path: "/system", label: "系统", description: "运行状态、日志和诊断", icon: Settings },
  { path: "/automation", label: "自动化", description: "管理 Agent 与定时任务", icon: CalendarClock },
];

export function routeForPath(pathname: string) {
  return primaryRoutes.find((route) => route.path === pathname) ?? primaryRoutes[0];
}
