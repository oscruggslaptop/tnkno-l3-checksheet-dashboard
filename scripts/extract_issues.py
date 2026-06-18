import json
import re
import sys
from datetime import datetime
from pathlib import Path

from pypdf import PdfReader


FIELD_LABELS = [
    "Status",
    "Type",
    "Description",
    "Assigned to",
    "Created by",
    "Created on",
    "Location",
    "Location details",
    "Due date",
    "Start date",
    "Root cause",
    "Commissioning Level",
    "Priority",
    "Punch List Type",
    "In Scope",
    "References and Attachments",
    "Comments",
]


def clean(raw):
    if raw is None:
        return None
    text = re.sub(r"\s+", " ", str(raw).replace("\u2014", "-")).strip()
    return text or None


def extract_between(block, label, next_labels=None):
    next_labels = next_labels or FIELD_LABELS
    next_pattern = "|".join(re.escape(item) for item in next_labels if item != label)
    pattern = rf"(?:^|\n){re.escape(label)}\s+(.+?)(?=\n(?:{next_pattern})\b|\nCommissioning\s+>|\nCustom fields\b|\nCreated by Omar Scruggs with Autodesk|$)"
    match = re.search(pattern, block, re.S)
    return clean(match.group(1)) if match else None


def parse_issue_block(block):
    heading = re.search(r"Issue detail\s+#(\d+):\s*(.+?)(?=\nStandard fields\b)", block, re.S)
    if not heading:
        return None

    due_date = extract_between(block, "Due date")
    due_late_match = re.search(r"\(([^)]+late)\)", due_date or "", re.I)
    comments = extract_between(block, "Comments", ["Created by Omar Scruggs with Autodesk"])

    return {
        "id": heading.group(1),
        "title": clean(heading.group(2)),
        "status": extract_between(block, "Status"),
        "description": extract_between(block, "Description"),
        "assignedTo": extract_between(block, "Assigned to"),
        "createdBy": extract_between(block, "Created by"),
        "createdOn": extract_between(block, "Created on"),
        "location": extract_between(block, "Location"),
        "locationDetails": extract_between(block, "Location details"),
        "dueDate": due_date,
        "dueStatus": clean(due_late_match.group(1)) if due_late_match else None,
        "priority": extract_between(block, "Priority"),
        "punchListType": extract_between(block, "Punch List Type"),
        "commissioningLevel": extract_between(block, "Commissioning Level"),
        "inScope": extract_between(block, "In Scope"),
        "latestComments": comments[:900] if comments else None,
    }


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract_issues.py <issues.pdf>")

    pdf_path = Path(sys.argv[1])
    reader = PdfReader(pdf_path)
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    blocks = re.split(r"(?=Issue detail\s+#\d+:)", text)
    issues = [issue for issue in (parse_issue_block(block) for block in blocks) if issue]

    status_counts = {}
    for issue in issues:
        status = issue.get("status") or "Unknown"
        status_counts[status] = status_counts.get(status, 0) + 1

    payload = {
        "sourceFile": pdf_path.name,
        "sourcePath": str(pdf_path),
        "lastModified": datetime.fromtimestamp(pdf_path.stat().st_mtime).isoformat(),
        "total": len(issues),
        "statusCounts": status_counts,
        "items": issues,
    }
    print(json.dumps(payload, default=str))


if __name__ == "__main__":
    main()
