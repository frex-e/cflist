import { fragmentUrl } from "./fragment-url.js";

type LoadMoreProps = {
  next: string;
  fragmentPath: string;
  label: string;
};

export const LoadMore = ({ next, fragmentPath, label }: LoadMoreProps) => {
  return (
    <div
      id="load-more"
      class="load-more"
      data-load-more
      hidden={!next}
      hx-get={next ? fragmentUrl(fragmentPath, next, { append: "1" }) : undefined}
      hx-trigger={next ? "loadMore" : undefined}
      hx-target={next ? "this" : undefined}
      hx-swap={next ? "outerHTML" : undefined}
    >
      <span>{label}</span>
    </div>
  );
};
