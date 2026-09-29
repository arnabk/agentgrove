export default function Logo(props: { class?: string; title?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2 4 7v10l8 5 8-5V7l-8-5Z"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
      <path
        d="M12 12 4 7m8 5 8-5m-8 5v10"
        stroke="var(--ag-accent)"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}
