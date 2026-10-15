/** Kept beside the clicked exit; showing it never moves the user's focus. */
export function ComponentLeaveConfirmation({
  onSave,
  onDiscard,
  onKeepEditing,
}: {
  onSave(): void;
  onDiscard(): void;
  onKeepEditing(): void;
}) {
  return (
    <div
      className="component-leave-confirmation"
      role="group"
      aria-label="Leave component editor"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onKeepEditing();
        }
      }}
    >
      <span>Unapplied changes.</span>
      <button type="button" onClick={onSave}>
        Save draft &amp; leave
      </button>
      <button type="button" onClick={onDiscard}>
        Discard
      </button>
      <button type="button" onClick={onKeepEditing}>
        Keep editing
      </button>
    </div>
  );
}
