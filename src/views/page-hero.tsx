import type { Child } from "hono/jsx";
import { raw } from "hono/html";

export const PageHero = (options: { title: string; subtitle: Child | string; aside?: Child | string }) => {
  const subtitle = typeof options.subtitle === "string" ? raw(options.subtitle) : options.subtitle;
  const aside = options.aside === undefined
    ? undefined
    : typeof options.aside === "string"
      ? raw(options.aside)
      : options.aside;

  return (
    <section class="hero">
      <div>
        <h1>{options.title}</h1>
        {subtitle}
      </div>
      {aside}
    </section>
  );
};
