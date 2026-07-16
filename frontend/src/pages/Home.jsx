import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getPosts } from "../api";
import PostCard from "../components/PostCard";
import { HiPlus } from "react-icons/hi";
import { FiInbox } from "react-icons/fi";
import { useAuth } from "../context/AuthContext";

function Home() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;

    let isActive = true;

    const fetchPosts = async () => {
      setLoading(true);
      try {
        const res = await getPosts();
        if (isActive) {
          setPosts(res.data);
        }
      } catch (err) {
        console.error("Failed to fetch posts:", err);
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    fetchPosts();

    return () => {
      isActive = false;
    };
  }, [authLoading, user?.id]);

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div>
      <div className="home-header">
        <h1>Welcome to ZYLO</h1>
        <p>
          A professional platform for publishing your insights, thoughts, and
          technical articles.
        </p>
        <div className="vibe-tags">
          <span className="vibe-tag">Technical Insights</span>
          <span className="vibe-tag">Industry Updates</span>
          <span className="vibe-tag">Professional Network</span>
        </div>
      </div>

      {posts.length === 0 ? (
        <div className="empty-state">
          <FiInbox size={48} color="#94a3b8" style={{ marginBottom: "1rem" }} />
          <h3>No articles published yet</h3>
          <p>
            {user
              ? "Be the first to share your professional insights."
              : "Sign in to publish your first article."}
          </p>
          {user ? (
            <Link to="/create" className="btn btn-primary">
              <HiPlus size={18} />
              Publish an Article
            </Link>
          ) : (
            <Link to="/login" className="btn btn-primary">
              Sign In to Post
            </Link>
          )}
        </div>
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
