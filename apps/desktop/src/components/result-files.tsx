import { Download } from "lucide-react";
import { useState } from "react";
import type { ControlPlane, ResultArtifact } from "../control-plane";
import { describe } from "../lib/polling";
import { Button } from "./ui/button";

export function ResultFiles({
  artifacts,
  onSave,
}: {
  artifacts: ResultArtifact[];
  onSave: ControlPlane["saveArtifact"];
}) {
  const [saving, setSaving] = useState<string>();
  const [feedback, setFeedback] = useState<{ key: string; text: string; error?: boolean }>();

  async function save(artifactId: string, path: string, key: string) {
    setSaving(key);
    setFeedback(undefined);
    try {
      if (await onSave(artifactId, path)) setFeedback({ key, text: "Saved." });
    } catch (error) {
      setFeedback({ key, text: describe(error), error: true });
    } finally {
      setSaving(undefined);
    }
  }

  return (
    <ul className="result-files" aria-label="Task result files">
      {artifacts.flatMap(({ artifactId, paths }) =>
        paths.map((path) => {
          const key = JSON.stringify([artifactId, path]);
          return (
            <li key={key}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="result-file"
                aria-label={`Save ${path}`}
                disabled={saving !== undefined}
                onClick={() => void save(artifactId, path, key)}
              >
                <Download aria-hidden="true" />
                <span>{path}</span>
                {saving === key && <span className="visually-hidden">Saving</span>}
              </Button>
              {feedback?.key === key && (
                <p className={feedback.error ? "field-error" : undefined} role="status">
                  {feedback.text}
                </p>
              )}
            </li>
          );
        }),
      )}
    </ul>
  );
}
