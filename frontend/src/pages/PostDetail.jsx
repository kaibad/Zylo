import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getPost, deletePost } from '../api';
import { formatDistanceToNow } from 'date-fns';
import { HiArrowLeft, HiPencil, HiTrash } from 'react-icons/hi2';
import { FiFileText, FiUser, FiLock, FiGlobe } from 'react-icons/fi';
import CommentSection from '../components/CommentSection';
import ConfirmModal from '../components/ConfirmModal';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

function PostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    fetchPost();
  }, [id]);

  const fetchPost = async () => {
    try {
      const res = await getPost(id);
      setPost(res.data);
    } catch (err) {
      if (err?.response?.status === 403) {
        setAccessDenied(true);
      } else {
        toast.error('Post not found');
        navigate('/');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deletePost(id);
      toast.success('Post deleted successfully');
      navigate('/');
    } catch (err) {
      toast.error('Failed to delete post');
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="empty-state">
        <FiLock size={48} color="#94a3b8" style={{ marginBottom: '1rem' }} />
        <h3>This post is private</h3>
        <p>You don't have permission to view this article.</p>
        <Link to="/" className="btn btn-secondary">Back to Feed</Link>
      </div>
    );
  }

  if (!post) return null;

  const timeAgo = formatDistanceToNow(new Date(post.created_at), { addSuffix: true });
  const wasEdited = post.updated_at !== post.created_at;
  const isOwner = user && user.id === post.user_id;

  return (
    <div className="post-detail">
      <div className="post-detail-header">
        <Link to="/" className="post-detail-back">
          <HiArrowLeft size={16} /> Back to feed
        </Link>

        <div className="post-detail-emoji" style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', display: 'inline-flex', padding: '0.6rem', borderRadius: '8px' }}>
          <FiFileText size={24} />
        </div>
        <h1 className="post-detail-title">{post.title}</h1>

        <div className="post-detail-meta">
          <span className="author-chip"><FiUser style={{ marginRight: '4px' }} /> {post.author}</span>
          <span>{timeAgo}</span>
          {wasEdited && <span style={{ color: 'var(--accent-purple)' }}>(edited)</span>}
          {post.is_private ? (
            <span className="privacy-badge"><FiLock size={11} /> Private</span>
          ) : (
            <span className="privacy-badge public"><FiGlobe size={11} /> Public</span>
          )}
        </div>

        {isOwner && (
          <div className="post-detail-actions">
            <Link to={`/edit/${post.id}`} className="btn btn-secondary btn-sm">
              <HiPencil size={16} /> Edit
            </Link>
            <button className="btn btn-danger btn-sm" onClick={() => setShowDeleteModal(true)}>
              <HiTrash size={16} /> Delete
            </button>
          </div>
        )}
      </div>

      <div className="post-detail-content">{post.content}</div>

      <CommentSection
        postId={post.id}
        comments={post.comments || []}
        onUpdate={fetchPost}
      />

      {showDeleteModal && (
        <ConfirmModal
          title="Delete this post?"
          message="This action is permanent and cannot be undone. All comments will be deleted as well."
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
}

export default PostDetail;
