import { useState, useEffect } from "react";
import { getPosts } from "../api";

export function usePosts({ enabled = true, dependency } = {}) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    let isActive = true;

    async function fetchPosts() {
      setLoading(true);
      setError(null);
      try {
        const res = await getPosts();
        if (isActive) setPosts(res.data);
      } catch (err) {
        console.error("Failed to fetch posts:", err);
        if (isActive) setError("Something went wrong while loading articles.");
      } finally {
        if (isActive) setLoading(false);
      }
    }

    fetchPosts();
    return () => {
      isActive = false;
    };
  }, [enabled, dependency]);

  return { posts, loading, error };
}
