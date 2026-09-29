import { useTranslation } from "@forgeax/chat/runtime";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Task } from "../../task-flow/model";
import {
	isTaskComplete,
	taskProgress,
	taskProgressKey,
} from "../../task-flow/task-progress";
import { useTaskFlowUiStore } from "../../task-flow/ui-store";
import { AgentIdentityAvatar } from "./AgentIdentityAvatar";
import { useAgentIdentities } from "./agent-identity";
import { executionFailureMessages } from "./execution-failure";
import { defaultStepOpen, defaultTaskOpen } from "./process-display";
import { StepRow } from "./StepRow";
import { ToolGroup } from "./ToolGroup";
import { canGroupTool, groupConsecutive } from "./tool-groups";
import { useOpenAgentThread } from "./use-agent-thread";
export function TaskCard({
	task,
	roundId,
	archive = false,
	fallbackAgentId,
	defaultOpen = false,
	sid,
}: {
	task: Task;
	roundId: string;
	archive?: boolean;
	fallbackAgentId?: string;
	defaultOpen?: boolean;
	sid?: string;
}) {
	const { t, i18n } = useTranslation();
	const failureCopy = executionFailureMessages(i18n?.language);
	const key = `${roundId}:${task.id}`;
	const running =
		task.status === "in_progress" &&
		!task.demotedFromActive &&
		!task.terminalState;
	const open = useTaskFlowUiStore((state) =>
		running
			? true
			: (state.openTasks[key] ??
				defaultTaskOpen({ defaultOpen, archive, running })),
	);
	const toggleTask = useTaskFlowUiStore((state) => state.toggleTask);
	const openSteps = useTaskFlowUiStore((state) => state.openSteps);
	const toggleStep = useTaskFlowUiStore((state) => state.toggleStep);
	const identity = useAgentIdentities()(task.agentId ?? fallbackAgentId);
	const openAgent = useOpenAgentThread();
	const done = isTaskComplete(task);
	const progressKey = taskProgressKey(sid, roundId, task.id);
	const previousProgress = useTaskFlowUiStore(
		(state) => state.taskProgress[progressKey] ?? 0,
	);
	const rememberProgress = useTaskFlowUiStore(
		(state) => state.rememberTaskProgress,
	);
	const progress = taskProgress(task, previousProgress);
	useLayoutEffect(() => {
		// Persist across collapse/remount, but never carry a completed 100% into
		// a task that is subsequently reopened by a new plan update.
		if (running) rememberProgress(progressKey, progress);
	}, [running, progressKey, progress, rememberProgress]);
	const stepsRef = useRef<HTMLDivElement>(null);
	const followStepsRef = useRef(true);
	useLayoutEffect(() => {
		const list = stepsRef.current;
		if (!open || !list) return;
		followStepsRef.current = true;
		list.scrollTop = list.scrollHeight;
		// Detail streaming and collapse animations change height after layout.
		const observer = new ResizeObserver(() => {
			if (followStepsRef.current) list.scrollTop = list.scrollHeight;
		});
		for (const child of list.children) observer.observe(child);
		return () => observer.disconnect();
	}, [open]);
	return (
		<section
			className={`tx-task tx-task-${task.status} ${open ? "is-open" : "is-folded"} ${archive ? "is-archive" : ""}`}
		>
			<div className="tx-th">
				{identity && (
					<button
						type="button"
						className="tx-th-av is-clickable"
						style={{ "--tx-ac": identity.accent } as React.CSSProperties}
						title={t("taskFlow.openAgentThread", { name: identity.name })}
						onClick={() => {
							if (task.agentId) openAgent(task.agentId);
						}}
					>
						<AgentIdentityAvatar
							identity={identity}
							agentId={task.agentId ?? fallbackAgentId}
							size={22}
						/>
					</button>
				)}
				<button
					type="button"
					className="tx-th-toggle"
					onClick={() => {
						if (!running) toggleTask(key, open);
					}}
					aria-expanded={open}
					aria-disabled={running}
				>
					{identity && (
						<span className="tx-th-who" style={{ color: identity.accent }}>
							{identity.name}
						</span>
					)}
					<span className="tx-th-goal">
						{task.activeForm && running ? task.activeForm : task.content}
					</span>
					<span className="tx-th-st">
						{done ? (
							<>
								<CheckCircle2 size={13} aria-hidden="true" />
								{t("taskFlow.statusDone")}
							</>
						) : running ? (
							<>
								<span className="tx-spin" aria-hidden="true" />
								{t("taskFlow.statusRunning")}
							</>
						) : (
							<>
								{task.terminalState === "interrupted"
									? failureCopy.interruptedTask
									: task.terminalState === "incomplete"
										? failureCopy.unfinishedTask
										: task.status === "cancelled"
											? failureCopy.cancelledTask
											: t("taskFlow.statusPending")}
							</>
						)}
					</span>
					{!running &&
						(open ? (
							<ChevronDown size={13} className="tx-th-cv" aria-hidden="true" />
						) : (
							<ChevronRight size={13} className="tx-th-cv" aria-hidden="true" />
						))}
				</button>
			</div>
			{(running || done) && (
				<div
					className="tx-prog"
					role="progressbar"
					aria-label={task.content}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={progress}
				>
					<i style={{ width: `${progress}%` }} />
				</div>
			)}
			<div className="tx-steps-wrap">
				<div
					className="tx-steps thin-scrollbar"
					role="log"
					ref={stepsRef}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: scroll regions must support keyboard scrolling.
					tabIndex={0}
					onScroll={(event) => {
						const list = event.currentTarget;
						followStepsRef.current =
							list.scrollHeight - list.scrollTop - list.clientHeight < 2;
					}}
				>
					{groupConsecutive(task.steps, canGroupTool).map((group) => {
						const rows = group.map((step) => {
							const index = task.steps.indexOf(step);
							return (
								<StepRow
									key={step.id}
									step={step}
									// While the task is running, keep the latest step's detail open so
									// the current activity (thinking / log / asset pill / diff) stays
									// visible — local tools finish in ms, so without this the running
									// step would collapse to a ✓ row before anything is readable.
									open={
										openSteps[`${key}:${step.id}`] ??
										defaultStepOpen({
											status: step.status,
											parentRunning: running,
											latest: index === task.steps.length - 1,
										})
									}
									onToggle={() => {
										const stepKey = `${key}:${step.id}`;
										const currentOpen =
											openSteps[stepKey] ??
											defaultStepOpen({
												status: step.status,
												parentRunning: running,
												latest: index === task.steps.length - 1,
											});
										toggleStep(stepKey, currentOpen);
									}}
									sid={sid}
									agentId={task.agentId ?? fallbackAgentId}
								/>
							);
						});
						return canGroupTool(group[0]) ? (
							<ToolGroup key={group[0].id} steps={group}>
								{rows}
							</ToolGroup>
						) : (
							rows
						);
					})}
					{!task.steps.length && (
						<div className="tx-steps-empty">{t("taskFlow.stepsEmpty")}</div>
					)}
				</div>
			</div>
		</section>
	);
}
