const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { authenticate, optionalAuth } = require('../middleware/auth');

// GET all posts — public posts + owner's private posts
router.get('/', optionalAuth, async (req, res) => {
  try {
    let result;
    if (req.user) {
      // Logged in: show all public posts + this user's own private posts
      result = await pool.query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
         FROM posts p
         WHERE p.is_private = false OR p.user_id = $1
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
    } else {
      // Logged out: show only public posts
      result = await pool.query(
        `SELECT p.*,
          (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) as comment_count
         FROM posts p
         WHERE p.is_private = false
         ORDER BY p.created_at DESC`
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET single post with comments — respects private visibility
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const postResult = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const post = postResult.rows[0];

    // Block access to private posts for non-owners
    if (post.is_private && (!req.user || req.user.id !== post.user_id)) {
      return res.status(403).json({ error: 'This post is private' });
    }

    const commentsResult = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ ...post, comments: commentsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// CREATE post — requires auth
router.post('/', authenticate, async (req, res) => {
  const { title, content, author, is_private } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO posts (title, content, author, user_id, is_private)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        title,
        content,
        author || req.user.username,
        req.user.id,
        is_private === true || is_private === 'true',
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// UPDATE post — requires auth + ownership
router.put('/:id', authenticate, async (req, res) => {
  const { title, content, author, is_private } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  try {
    // Check ownership
    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not have permission to edit this post' });
    }

    const result = await pool.query(
      `UPDATE posts
       SET title = $1, content = $2, author = $3, is_private = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [title, content, author || req.user.username, is_private === true || is_private === 'true', req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE post — requires auth + ownership
router.delete('/:id', authenticate, async (req, res) => {
  try {
    // Check ownership
    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    if (existing.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not have permission to delete this post' });
    }

    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Post deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

module.exports = router;
