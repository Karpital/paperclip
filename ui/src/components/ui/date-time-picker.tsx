import { useState, useEffect } from "react";
import { Calendar, X, Clock } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Format a date string for display: "Mar 7, 15:30"
 */
export function formatDateTimeShort(isoOrLocal: string): string {
  const d = isoOrLocal.includes("T")
    ? new Date(isoOrLocal.includes("Z") || isoOrLocal.includes("+") ? isoOrLocal : isoOrLocal + "Z")
    : new Date(isoOrLocal);
  if (isNaN(d.getTime())) return isoOrLocal;

  // If the value is a local datetime string (no Z/offset), parse parts directly
  const parts = isoOrLocal.split("T");
  if (parts.length === 2 && !isoOrLocal.includes("Z") && !isoOrLocal.includes("+")) {
    const [datePart, timePart] = parts;
    const [y, m, day] = datePart.split("-").map(Number);
    const [hh, mm] = timePart.split(":").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[m - 1]} ${day}, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Parse a datetime-local string "YYYY-MM-DDThh:mm" into parts
 */
function parseParts(value: string): { date: string; hours: string; minutes: string } {
  if (!value) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return {
      date: `${y}-${m}-${d}`,
      hours: String(now.getHours()).padStart(2, "0"),
      minutes: String(now.getMinutes()).padStart(2, "0"),
    };
  }
  const parts = value.split("T");
  const datePart = parts[0] || "";
  const timePart = parts[1] || "00:00";
  const [hh, mm] = timePart.split(":");
  return { date: datePart, hours: hh || "00", minutes: mm || "00" };
}

function combine(date: string, hours: string, minutes: string): string {
  return `${date}T${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

interface DateTimePickerProps {
  /** Current value in "YYYY-MM-DDThh:mm" format (datetime-local style) */
  value: string;
  /** Called with new value in "YYYY-MM-DDThh:mm" format */
  onChange: (value: string) => void;
  /** Called when user clears the value */
  onClear?: () => void;
  /** Compact chip mode (for NewIssueDialog bottom bar) */
  variant?: "chip" | "property";
  /** Label shown in chip mode */
  label?: string;
}

export function DateTimePicker({ value, onChange, onClear, variant = "chip", label }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const { date, hours, minutes } = parseParts(value);
  const [editDate, setEditDate] = useState(date);
  const [editHours, setEditHours] = useState(hours);
  const [editMinutes, setEditMinutes] = useState(minutes);

  // Sync internal state when value prop changes
  useEffect(() => {
    const p = parseParts(value);
    setEditDate(p.date);
    setEditHours(p.hours);
    setEditMinutes(p.minutes);
  }, [value]);

  const handleDateChange = (newDate: string) => {
    setEditDate(newDate);
    onChange(combine(newDate, editHours, editMinutes));
  };

  const handleHourClick = (h: string) => {
    setEditHours(h);
    onChange(combine(editDate, h, editMinutes));
  };

  const handleMinuteClick = (m: string) => {
    setEditMinutes(m);
    onChange(combine(editDate, editHours, m));
  };

  const displayText = value ? formatDateTimeShort(value) : (label || "Set date");

  const pickerContent = (
    <div className="flex flex-col gap-2 p-2">
      {/* Date input */}
      <div className="flex items-center gap-2">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          type="date"
          className="flex-1 bg-transparent text-sm outline-none border border-border rounded-md px-2 py-1 text-foreground [color-scheme:dark]"
          value={editDate}
          onChange={(e) => handleDateChange(e.target.value)}
        />
      </div>

      {/* Time selectors — native <select> for guaranteed scroll/interaction inside Dialog */}
      <div className="flex items-center gap-2">
        <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="flex items-center gap-1 flex-1">
          <select
            value={editHours}
            onChange={(e) => handleHourClick(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none border border-border rounded-md px-2 py-1.5 text-foreground [color-scheme:dark] cursor-pointer"
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>

          <span className="text-sm text-muted-foreground font-medium">:</span>

          <select
            value={editMinutes}
            onChange={(e) => handleMinuteClick(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none border border-border rounded-md px-2 py-1.5 text-foreground [color-scheme:dark] cursor-pointer"
          >
            {MINUTES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Current value preview */}
      {value && (
        <div className="text-xs text-muted-foreground text-center pt-1 border-t border-border">
          {formatDateTimeShort(value)}
        </div>
      )}
    </div>
  );

  if (variant === "property") {
    return (
      <div className="flex items-center gap-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-1.5 text-sm hover:bg-accent/50 rounded px-1 py-0.5 transition-colors">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <span className={value ? "text-foreground" : "text-muted-foreground"}>
                {displayText}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[220px] p-0" align="start">
            {pickerContent}
          </PopoverContent>
        </Popover>
        {value && onClear && (
          <button onClick={onClear} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  // Chip variant (default) for NewIssueDialog
  return (
    <span className="inline-flex items-center gap-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground cursor-pointer hover:bg-accent/50 transition-colors">
            <Calendar className="h-3 w-3" />
            <span>{displayText}</span>
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-0" align="start">
          {pickerContent}
        </PopoverContent>
      </Popover>
      {value && onClear && (
        <button onClick={(e) => { e.stopPropagation(); onClear(); }} className="hover:text-foreground text-muted-foreground ml-1">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
