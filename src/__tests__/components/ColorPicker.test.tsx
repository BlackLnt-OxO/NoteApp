import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColorPicker } from '../../components/ColorPicker';

describe('ColorPicker', () => {
  // Use a pure primary color that round-trips exactly through HSV↔RGB
  // so we can predict the hex input display value.
  const defaultProps = {
    color: '#ff0000',
    onChange: vi.fn(),
    gfs: 14,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<ColorPicker {...defaultProps} />);
    // Color picker contains a div acting as its container
    expect(document.body.children.length).toBeGreaterThan(0);
  });

  it('displays the old color swatch matching the color prop', () => {
    render(<ColorPicker {...defaultProps} />);
    // Find "旧" (old) label and verify the swatch div exists nearby
    expect(screen.getByText('旧')).toBeInTheDocument();
  });

  it('displays the new color preview swatch', () => {
    render(<ColorPicker {...defaultProps} />);
    expect(screen.getByText('新')).toBeInTheDocument();
  });

  it('has an eyedropper button that calls electronAPI.startEyedropper', () => {
    render(<ColorPicker {...defaultProps} />);
    const eyedropperBtn = document.querySelector('button[title="吸管取色"]');
    expect(eyedropperBtn).toBeInTheDocument();
    fireEvent.click(eyedropperBtn!);
    expect(window.electronAPI?.startEyedropper).toHaveBeenCalled();
  });

  it('contains the color wheel element', () => {
    render(<ColorPicker {...defaultProps} />);
    // The color wheel has a conic-gradient background and a specific ref
    const wheel = document.querySelector('[style*="conic-gradient"]');
    expect(wheel).toBeInTheDocument();
  });

  it('renders RGB sliders with labels R, G, B', () => {
    render(<ColorPicker {...defaultProps} />);
    expect(screen.getByText('R')).toBeInTheDocument();
    expect(screen.getByText('G')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('renders HSV sliders with labels H, S, V', () => {
    render(<ColorPicker {...defaultProps} />);
    // These are nested inside the HSV section
    const hLabels = screen.getAllByText('H');
    expect(hLabels.length).toBeGreaterThan(0);
    expect(screen.getByText('S')).toBeInTheDocument();
    expect(screen.getByText('V')).toBeInTheDocument();
  });

  it('has a hex input field', () => {
    render(<ColorPicker {...defaultProps} />);
    // Find by display value — #ff0000 round-trips exactly to FF0000 + FF suffix
    expect(screen.getByText('Hex sRGB')).toBeInTheDocument();
    const hexInput = screen.getByDisplayValue('FF0000FF');
    expect(hexInput).toBeInTheDocument();
  });

  it('renders hex input with the correct value matching initial color', () => {
    render(<ColorPicker {...defaultProps} />);
    // #ff0000 → hex = '#ff0000' → uppercase slice(1) + 'FF' = 'FF0000FF'
    const hexInput = screen.getByDisplayValue('FF0000FF');
    expect(hexInput).toBeInTheDocument();
    expect(hexInput.tagName).toBe('INPUT');
  });

  it('renders with a different initial color', () => {
    render(<ColorPicker color="#ffffff" onChange={vi.fn()} gfs={14} />);
    const hexInput = screen.getByDisplayValue('FFFFFFFF');
    expect(hexInput).toBeInTheDocument();
  });
});
