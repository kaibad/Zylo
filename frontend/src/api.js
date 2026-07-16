import axios from "axios";

const API_BASE = "/api";

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    "Content-Type": "application/json",
  },
});

const syncAuthHeader = () => {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("zylo_token") : null;
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
};

syncAuthHeader();

api.interceptors.request.use((config) => {
  syncAuthHeader();
  if (config.headers) {
    config.headers.Authorization = api.defaults.headers.common.Authorization;
  }
  return config;
});

// Auth
export const register = (data) => api.post("/auth/register", data);
export const login = (data) => api.post("/auth/login", data);

// Posts
export const getPosts = () => api.get("/posts");
export const getPost = (id) => api.get(`/posts/${id}`);
export const createPost = (data) => api.post("/posts", data);
export const updatePost = (id, data) => api.put(`/posts/${id}`, data);
export const deletePost = (id) => api.delete(`/posts/${id}`);

// Comments
export const getComments = (postId) => api.get(`/comments/post/${postId}`);
export const createComment = (data) => api.post("/comments", data);
export const deleteComment = (id) => api.delete(`/comments/${id}`);

export default api;
