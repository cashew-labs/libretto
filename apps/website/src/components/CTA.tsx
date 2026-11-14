import { InstallSnippet } from "./InstallSnippet.js";
import { SectionIntro } from "./SectionIntro.js";
import { SiteSection } from "./SiteSection.js";

export function CTA() {
  return (
    <SiteSection innerClassName="text-center">
      <SectionIntro copyClassName="mb-8" title="Ready to get started?">
        Read the docs to set up Libretto and build your first integration in
        minutes.
      </SectionIntro>
      <div className="flex flex-col items-center gap-3">
        <InstallSnippet fathomEvent="CTA copy prompt click" />
      </div>
    </SiteSection>
  );
}
