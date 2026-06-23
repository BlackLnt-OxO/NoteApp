import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FirstScreenshotPrompt from '../../components/FirstScreenshotPrompt';
import { useNoteStore } from '../../store';

describe('FirstScreenshotPrompt', () => {
  beforeEach(() => {
    // Ensure store has default settings so fontSize is available
    useNoteStore.setState(
      {
        settings: {
          ...useNoteStore.getState().settings,
          fontSize: 14,
        },
      },
      false,
    );
    vi.clearAllMocks();
  });

  it('renders the prompt title', () => {
    render(<FirstScreenshotPrompt onClose={vi.fn()} />);
    expect(screen.getByText('截图时视频黑屏？')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    render(<FirstScreenshotPrompt onClose={vi.fn()} />);
    expect(
      screen.getByText(/截图覆盖层可能导致 Chrome\/Edge 浏览器中的视频/),
    ).toBeInTheDocument();
  });

  it('renders the decline button ("不了")', () => {
    render(<FirstScreenshotPrompt onClose={vi.fn()} />);
    expect(screen.getByText('不了')).toBeInTheDocument();
  });

  it('renders the accept button ("是，帮我设置")', () => {
    render(<FirstScreenshotPrompt onClose={vi.fn()} />);
    expect(screen.getByText('是，帮我设置')).toBeInTheDocument();
  });

  it('calls onClose(false) when decline button is clicked', () => {
    const onClose = vi.fn();
    render(<FirstScreenshotPrompt onClose={onClose} />);
    fireEvent.click(screen.getByText('不了'));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('calls onClose(true) when accept button is clicked', () => {
    const onClose = vi.fn();
    render(<FirstScreenshotPrompt onClose={onClose} />);
    fireEvent.click(screen.getByText('是，帮我设置'));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('calls onClose(false) when overlay backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<FirstScreenshotPrompt onClose={onClose} />);
    // The overlay is the outermost div with class "dialog-overlay"
    const overlay = document.querySelector('.dialog-overlay');
    expect(overlay).toBeInTheDocument();
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
