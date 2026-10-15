import { useEffect, useState } from "react";
import { ApiError, type RepoEndorsements } from "../lib/api.js";
import { createClient } from "../lib/settings.js";

interface Props {
  owner: string;
  name: string;
}

/**
 * The in-page badge answers one question: "do the accounts I track also star
 * this repo?" It renders nothing when the answer is "no" or "not tracked", so
 * it never adds noise to repositories outside the knowledge base.
 */
export function EndorsementBadge({ owner, name }: Props) {
  const [data, setData] = useState<RepoEndorsements | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const client = await createClient();
        const result = await client.repoEndorsements(owner, name);
        if (active) setData(result);
      } catch (cause) {
        // A missing service must not disturb the GitHub page, so a connection
        // failure simply hides the badge.
        if (active) {
          setHidden(cause instanceof ApiError);
        }
      }
    })();
    return () => {
      active = false;
      setData(null);
    };
  }, [owner, name]);

  if (hidden || !data?.endorsements.length) return null;

  return (
    <div className="endorse" title={`这个仓库被 ${data.endorsements.length} 个订阅账号 star`}>
      <span className="endorse-title">订阅的大佬也 star 了</span>
      <span className="endorse-list">
        {data.endorsements.map((entry) => (
          <span className="endorse-chip" key={entry.login}>
            {entry.name ?? entry.login}
          </span>
        ))}
      </span>
    </div>
  );
}
