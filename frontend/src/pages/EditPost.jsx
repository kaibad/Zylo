import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { getPost, updatePost } from '../api';
import { HiArrowLeft } from 'react-icons/hi2';
import { FiGlobe, FiLock } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

function EditPost() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchPost();
  }, [id]);

  const fetchPost = async () => {
    try {
      const res = await getPost(id);
      const post = res.data;

      // Ownership check: only the owner can edit
      if (!user || user.id !== post.user_id) {
        toast.error('You do not have permission to edit this post');
        navigate('/');
        return;
      }

      setTitle(post.title);
      setContent(post.content);
      setIsPrivate(post.is_private);
    } catch (err) {
      toast.error('Post not found');
      navigate('/');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are required.');
      return;
    }
    setSubmitting(true);
    try {
      await updatePost(id, {
        title: title.trim(),
        content: content.trim(),
        author: user.username,
        is_private: isPrivate,
      });
      toast.success('Post updated successfully');
      navigate(`/post/${id}`);
    } catch (err) {
      toast.error('Failed to update post');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="form-page">
      <Link to={`/post/${id}`} className="post-detail-back">
        <HiArrowLeft size={16} /> Back to post
      </Link>
      <h1>Edit Article</h1>

      <form className="form-card" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            placeholder="Enter article title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={255}
          />
        </div>

        <div className="form-group">
          <label htmlFor="author">Author</label>
          <input
            id="author"
            type="text"
            value={user?.username || ''}
            disabled
            style={{ opacity: 0.6, cursor: 'not-allowed' }}
          />
        </div>

        <div className="form-group">
          <label htmlFor="content">Content</label>
          <textarea
            id="content"
            placeholder="Update your article content here..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Visibility</label>
          <div className="visibility-toggle">
            <button
              type="button"
              className={`visibility-option ${!isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(false)}
            >
              <FiGlobe size={16} />
              Public
              <span className="visibility-desc">Visible to everyone</span>
            </button>
            <button
              type="button"
              className={`visibility-option ${isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(true)}
            >
              <FiLock size={16} />
              Private
              <span className="visibility-desc">Only visible to you</span>
            </button>
          </div>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save changes'}
          </button>
          <Link to={`/post/${id}`} className="btn btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

export default EditPost;
