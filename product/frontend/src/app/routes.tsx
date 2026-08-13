import type { LucideIcon } from "lucide-react";
import { Brain, BriefcaseBusiness, CalendarClock, ChartNoAxesCombined, Folder, PlugZap, Settings, Sparkles, WalletCards } from "lucide-react";

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
  { path: "/capabilities", label: "能力", description: "管理本地已安装 Skill", icon: Sparkles },
  { path: "/connections", label: "连接", description: "渠道和第三方服务", icon: PlugZap },
  { path: "/automation", label: "自动化", description: "管理 Agent 与定时任务", icon: CalendarClock },
  { path: "/usage", label: "用量", description: "查看积分消耗、使用趋势与模型分布", icon: ChartNoAxesCombined },
  { path: "/balance", label: "余额", description: "查看积分余额与收支明细", icon: WalletCards },
  { path: "/system", label: "系统", description: "运行状态、日志和诊断", icon: Settings },
];

export function routeForPath(pathname: string) {
  return primaryRoutes.find((route) => route.path === pathname) ?? primaryRoutes[0];
}
