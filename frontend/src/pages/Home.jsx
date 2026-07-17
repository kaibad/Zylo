import { FiInbox } from "react-icons/fi";
import { useAuth } from "../context/AuthContext";
import { usePosts } from "../hooks/usePosts";
import PostCard from "../components/PostCard";
import LoadingSpinner from "../components/LoadingSpinner";
import EmptyState from "../components/EmptyState";
import HomeHero from "../components/HomeHero";

function Home() {
  const { user, loading: authLoading } = useAuth();
  const { posts, loading, error } = usePosts({
    enabled: !authLoading,
    dependency: user?.id,
  });

  if (authLoading || loading) {
    return <LoadingSpinner />;
  }

  return (
    <div>
      <HomeHero />

      {error ? (
        <EmptyState
          icon={
            <FiInbox
              size={48}
              color="#ef4444"
              style={{ marginBottom: "1rem" }}
            />
          }
          title="Couldn't load articles"
          description={error}
        />
      ) : posts.length === 0 ? (
        <EmptyState
          icon={
            <FiInbox
              size={48}
              color="#94a3b8"
              style={{ marginBottom: "1rem" }}
            />
          }
          title="No articles published yet"
          description={
            user
              ? "Be the first to share your professional insights — use Publish in the top bar."
              : "Sign in from the top bar to publish your first article."
          }
        />
      ) : (
        <div className="posts-grid">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}

export default Home;
