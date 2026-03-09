import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, Paperclip, Plus, Trash2 } from "lucide-react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { companiesApi } from "../api/companies";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Company } from "@paperclipai/shared";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

const ORDER_STORAGE_KEY = "paperclip.companyOrder";

function getStoredOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveOrder(ids: string[]) {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
}

/** Sort companies by stored order, appending any new ones at the end. */
function sortByStoredOrder(companies: Company[]): Company[] {
  const order = getStoredOrder();
  if (order.length === 0) return companies;

  const byId = new Map(companies.map((c) => [c.id, c]));
  const sorted: Company[] = [];

  for (const id of order) {
    const c = byId.get(id);
    if (c) {
      sorted.push(c);
      byId.delete(id);
    }
  }
  // Append any companies not in stored order
  for (const c of byId.values()) {
    sorted.push(c);
  }
  return sorted;
}

function SortableCompanyItem({
  company,
  isSelected,
  hasLiveAgents,
  hasUnreadInbox,
  onSelect,
}: {
  company: Company;
  isSelected: boolean;
  hasLiveAgents: boolean;
  hasUnreadInbox: boolean;
  onSelect: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="overflow-visible">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <a
            href={`/${company.issuePrefix}/dashboard`}
            onClick={(e) => {
              e.preventDefault();
              onSelect();
            }}
            className="relative flex items-center justify-center group overflow-visible"
          >
            {/* Selection indicator pill */}
            <div
              className={cn(
                "absolute left-[-14px] w-1 rounded-r-full bg-foreground transition-[height] duration-150",
                isSelected
                  ? "h-5"
                  : "h-0 group-hover:h-2"
              )}
            />
            <div
              className={cn("relative overflow-visible transition-transform duration-150", isDragging && "scale-105")}
            >
              <CompanyPatternIcon
                companyName={company.name}
                brandColor={company.brandColor}
                className={cn(
                  isSelected
                    ? "rounded-[14px]"
                    : "rounded-[22px] group-hover:rounded-[14px]",
                  isDragging && "shadow-lg",
                )}
              />
              {hasLiveAgents && (
                <span className="pointer-events-none absolute -right-0.5 -top-0.5 z-10">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-80" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-background" />
                  </span>
                </span>
              )}
              {hasUnreadInbox && (
                <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 z-10 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-background" />
              )}
            </div>
          </a>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p>{company.name}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function ArchivedCompanyCard({
  company,
  unarchiveMutation,
  removeMutation,
}: {
  company: Company;
  unarchiveMutation: { isPending: boolean; mutate: (id: string) => void };
  removeMutation: { isPending: boolean; mutate: (id: string) => void };
}) {
  const [expanded, setExpanded] = useState(false);
  const daysLeft = company.archivedAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(company.archivedAt).getTime() +
            30 * 24 * 60 * 60 * 1000 -
            Date.now()) /
            (24 * 60 * 60 * 1000),
        ),
      )
    : null;

  // Lazy-load agents and issues only when expanded
  const agentsQuery = useQuery({
    queryKey: ["archived-agents", company.id],
    queryFn: () => agentsApi.list(company.id),
    enabled: expanded,
  });
  const issuesQuery = useQuery({
    queryKey: ["archived-issues", company.id],
    queryFn: () => issuesApi.list(company.id),
    enabled: expanded,
  });

  const isLoading = expanded && (agentsQuery.isLoading || issuesQuery.isLoading);

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 opacity-60">
          <CompanyPatternIcon
            companyName={company.name}
            brandColor={company.brandColor}
            className="rounded-[10px] !w-9 !h-9"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{company.name}</div>
          {daysLeft !== null && (
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Auto-delete in {daysLeft} day{daysLeft !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {/* Collapsible description toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors w-full"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            expanded && "rotate-180",
          )}
        />
        <span>Description</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="rounded-md bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground space-y-2">
          {/* Company description */}
          {company.description && (
            <p className="leading-relaxed">
              {company.description.length > 400
                ? company.description.slice(0, 400) + "…"
                : company.description}
            </p>
          )}

          {/* Archive reason */}
          {company.archiveReason && (
            <p className="text-amber-600">
              Archive reason: {company.archiveReason}
            </p>
          )}

          {isLoading ? (
            <p className="text-[10px] italic">Loading...</p>
          ) : (
            <>
              {/* Agents */}
              {agentsQuery.data && agentsQuery.data.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground/70 uppercase mb-0.5">
                    Agents ({agentsQuery.data.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {agentsQuery.data.slice(0, 8).map((agent) => (
                      <span
                        key={agent.id}
                        className="inline-flex items-center rounded-full bg-background px-1.5 py-0.5 text-[10px] border border-border"
                      >
                        {agent.name}
                      </span>
                    ))}
                    {agentsQuery.data.length > 8 && (
                      <span className="text-[10px] text-muted-foreground/60">
                        +{agentsQuery.data.length - 8} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Recent issues */}
              {issuesQuery.data && issuesQuery.data.length > 0 && (
                <div>
                  <div className="text-[10px] font-medium text-muted-foreground/70 uppercase mb-0.5">
                    Recent issues ({issuesQuery.data.length})
                  </div>
                  <ul className="space-y-0.5">
                    {issuesQuery.data.slice(0, 5).map((issue) => (
                      <li key={issue.id} className="text-[11px] truncate">
                        <span className={cn(
                          "inline-block w-1.5 h-1.5 rounded-full mr-1",
                          issue.status === "done" ? "bg-green-500" :
                          issue.status === "in_progress" ? "bg-blue-500" :
                          "bg-muted-foreground/40",
                        )} />
                        {issue.title}
                      </li>
                    ))}
                    {issuesQuery.data.length > 5 && (
                      <li className="text-[10px] text-muted-foreground/60">
                        +{issuesQuery.data.length - 5} more issues
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {/* Fallback if nothing */}
              {(!agentsQuery.data || agentsQuery.data.length === 0) &&
                (!issuesQuery.data || issuesQuery.data.length === 0) &&
                !company.description && (
                  <p className="italic">No additional info available.</p>
                )}
            </>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          className="group/btn flex-1 flex items-center justify-center gap-1.5 h-9 rounded-md border border-green-300 bg-green-50 text-green-700 hover:bg-green-100 hover:border-green-400 transition-colors disabled:opacity-50"
          disabled={unarchiveMutation.isPending}
          onClick={() => unarchiveMutation.mutate(company.id)}
          aria-label={`Restore ${company.name}`}
        >
          <ArchiveRestore className="h-4 w-4" />
          <span className="text-xs font-medium hidden group-hover/btn:inline">
            Restore
          </span>
        </button>
        <button
          className="group/btn flex-1 flex items-center justify-center gap-1.5 h-9 rounded-md border border-red-300 bg-red-50 text-red-600 hover:bg-red-100 hover:border-red-400 transition-colors disabled:opacity-50"
          disabled={removeMutation.isPending}
          onClick={() => {
            const confirmed = window.confirm(
              `Permanently delete "${company.name}"? This will remove all agents, issues, projects, and data. This cannot be undone.`,
            );
            if (confirmed) removeMutation.mutate(company.id);
          }}
          aria-label={`Delete ${company.name} forever`}
        >
          <Trash2 className="h-4 w-4" />
          <span className="text-xs font-medium hidden group-hover/btn:inline">
            Delete forever
          </span>
        </button>
      </div>
    </div>
  );
}

function ArchivedPopoverContent({
  companies,
  unarchiveMutation,
  removeMutation,
}: {
  companies: Company[];
  unarchiveMutation: { isPending: boolean; mutate: (id: string) => void };
  removeMutation: { isPending: boolean; mutate: (id: string) => void };
}) {
  return (
    <PopoverContent side="right" align="end" className="w-96 p-3">
      <div className="text-xs font-medium text-muted-foreground mb-3 px-1">
        Archived companies
      </div>
      <div className="space-y-3 max-h-[28rem] overflow-y-auto">
        {companies.map((company) => (
          <ArchivedCompanyCard
            key={company.id}
            company={company}
            unarchiveMutation={unarchiveMutation}
            removeMutation={removeMutation}
          />
        ))}
      </div>
    </PopoverContent>
  );
}

export function CompanyRail() {
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const queryClient = useQueryClient();
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const archivedCompanies = useMemo(
    () => companies.filter((company) => company.status === "archived"),
    [companies],
  );

  const unarchiveMutation = useMutation({
    mutationFn: (companyId: string) => companiesApi.unarchive(companyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (companyId: string) => companiesApi.remove(companyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
    },
  });
  const companyIds = useMemo(() => sidebarCompanies.map((company) => company.id), [sidebarCompanies]);

  const liveRunsQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.liveRuns(companyId),
      queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
      refetchInterval: 10_000,
    })),
  });
  const sidebarBadgeQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.sidebarBadges(companyId),
      queryFn: () => sidebarBadgesApi.get(companyId),
      refetchInterval: 15_000,
    })),
  });
  const hasLiveAgentsByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, (liveRunsQueries[index]?.data?.length ?? 0) > 0);
    });
    return result;
  }, [companyIds, liveRunsQueries]);
  const hasUnreadInboxByCompanyId = useMemo(() => {
    const result = new Map<string, boolean>();
    companyIds.forEach((companyId, index) => {
      result.set(companyId, (sidebarBadgeQueries[index]?.data?.inbox ?? 0) > 0);
    });
    return result;
  }, [companyIds, sidebarBadgeQueries]);

  // Maintain sorted order in local state, synced from companies + localStorage
  const [orderedIds, setOrderedIds] = useState<string[]>(() =>
    sortByStoredOrder(sidebarCompanies).map((c) => c.id)
  );

  // Re-sync orderedIds from localStorage whenever companies changes.
  // Handles initial data load (companies starts as [] before query resolves)
  // and subsequent refetches triggered by live updates.
  useEffect(() => {
    if (sidebarCompanies.length === 0) {
      setOrderedIds([]);
      return;
    }
    setOrderedIds(sortByStoredOrder(sidebarCompanies).map((c) => c.id));
  }, [sidebarCompanies]);

  // Sync order across tabs via the native storage event
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== ORDER_STORAGE_KEY) return;
      try {
        const ids: string[] = e.newValue ? JSON.parse(e.newValue) : [];
        setOrderedIds(ids);
      } catch { /* ignore malformed data */ }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Re-derive when companies change (new company added/removed)
  const orderedCompanies = useMemo(() => {
    const byId = new Map(sidebarCompanies.map((c) => [c.id, c]));
    const result: Company[] = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (c) {
        result.push(c);
        byId.delete(id);
      }
    }
    // Append any new companies not yet in our order
    for (const c of byId.values()) {
      result.push(c);
    }
    return result;
  }, [sidebarCompanies, orderedIds]);

  // Require 8px of movement before starting a drag to avoid interfering with clicks
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((c) => c.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const newIds = arrayMove(ids, oldIndex, newIndex);
      setOrderedIds(newIds);
      saveOrder(newIds);
    },
    [orderedCompanies]
  );

  return (
    <div className="flex flex-col items-center w-[72px] shrink-0 h-full bg-background border-r border-border">
      {/* Paperclip icon - aligned with top sections (implied line, no visible border) */}
      <div className="flex items-center justify-center h-12 w-full shrink-0">
        <Paperclip className="h-5 w-5 text-foreground" />
      </div>

      {/* Company list */}
      <div className="flex-1 flex flex-col items-center gap-2 py-3 w-full overflow-y-auto overflow-x-hidden scrollbar-none">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedCompanies.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {orderedCompanies.map((company) => (
              <SortableCompanyItem
                key={company.id}
                company={company}
                isSelected={company.id === selectedCompanyId}
                hasLiveAgents={hasLiveAgentsByCompanyId.get(company.id) ?? false}
                hasUnreadInbox={hasUnreadInboxByCompanyId.get(company.id) ?? false}
                onSelect={() => setSelectedCompanyId(company.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Separator before archive + add buttons */}
      <div className="w-8 h-px bg-border mx-auto shrink-0" />

      {/* Archived companies button */}
      {archivedCompanies.length > 0 && (
        <div className="flex items-center justify-center pt-2 shrink-0">
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="relative flex items-center justify-center w-11 h-11 rounded-[22px] hover:rounded-[14px] border border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-[border-color,color,border-radius] duration-150"
                aria-label="Archived companies"
                title="Archived companies"
              >
                <Archive className="h-4 w-4" />
                <span className="absolute -top-1 -right-1 flex items-center justify-center h-4 min-w-4 rounded-full bg-amber-500 text-[10px] font-medium text-white px-1">
                  {archivedCompanies.length}
                </span>
              </button>
            </PopoverTrigger>
            <ArchivedPopoverContent
              companies={archivedCompanies}
              unarchiveMutation={unarchiveMutation}
              removeMutation={removeMutation}
            />
          </Popover>
        </div>
      )}

      {/* Add company button */}
      <div className="flex items-center justify-center py-2 shrink-0">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              onClick={() => openOnboarding()}
              className="flex items-center justify-center w-11 h-11 rounded-[22px] hover:rounded-[14px] border-2 border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-[border-color,color,border-radius] duration-150"
              aria-label="Add company"
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <p>Add company</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
