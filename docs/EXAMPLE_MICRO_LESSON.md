# Example Micro-Lesson: Speculative Decoding

This document shows what a generated micro-lesson would look like when delivered to Mikey via Signal digest or CLI.

---

## Format: Quick Context (Default - 200 words)

```
🎯 Gap: Speculative Decoding

📖 Quick Context:
Speculative decoding is a technique to speed up LLM inference without sacrificing output quality.

The core idea: Use a small, fast "draft" model to generate multiple tokens ahead, then verify them in parallel with the big target model. If the draft tokens match what the big model would have generated, you skip the expensive autoregressive steps. If they don't match, you only wasted cheap draft compute—the big model corrects and continues.

Think of it like: autocomplete that double-checks itself. Your phone suggests the next 3 words, and only if you'd actually type them does it commit. Otherwise, it backs up and tries again.

Why it matters: Makes models like GPT-4 or Llama-70B 2-3x faster on long generations (especially helpful for code, creative writing, or detailed explanations). The speedup comes "for free"—no quality loss, no extra training.

📚 Seen in: "Fast Inference with Speculative Sampling" (Leviathan et al., arXiv:2302.01318)

🔗 Want deeper dive? Reply /learn speculative-decoding
✓ Mark as understood: /understood speculative-decoding
```

**Length:** 184 words  
**Delivery:** Injected into LLM Engineering digest, placed BEFORE papers that mention speculative decoding  
**Read time:** ~45 seconds

---

## Format: Deep Dive (On-Demand - 1200 words)

```
# Deep Dive: Speculative Decoding

## Overview

Speculative decoding (also called "speculative sampling" or "assisted generation") is an inference optimization technique that accelerates autoregressive language model generation by using a smaller "draft" model to predict future tokens, then verifying those predictions in parallel with the target model.

Traditional LLM inference is slow because it's sequential: generate token 1, feed it back in, generate token 2, repeat. Each step requires a full forward pass through the model. For a 70B parameter model, each token takes ~100ms on A100 GPUs.

Speculative decoding breaks this bottleneck by:
1. Generating K tokens quickly with a small draft model (e.g., 7B params)
2. Verifying all K tokens in parallel with the target model in a single forward pass
3. Accepting matching tokens, rejecting mismatches, and continuing from the divergence point

The result: 2-3x speedup with mathematically guaranteed distribution preservation (the output distribution is identical to standard sampling).

## How It Works

### Algorithm Overview

**Input:**
- Target model M_target (large, slow, high quality)
- Draft model M_draft (small, fast, lower quality)  
- Prompt tokens x_1, ..., x_n
- Lookahead budget K (typically 3-8)

**Process:**

1. **Draft Phase:**
   - Use M_draft to generate K candidate tokens autoregressively
   - Draft tokens: y_1, y_2, ..., y_K
   - Store draft probabilities p_draft(y_i | x_1...x_n, y_1...y_{i-1})

2. **Verification Phase:**
   - Run M_target ONCE on entire sequence [x_1...x_n, y_1...y_K]
   - Get target probabilities p_target(y_i | x_1...x_n, y_1...y_{i-1}) for all i
   - Parallel computation → big speedup

3. **Acceptance/Rejection:**
   - For i = 1 to K:
     - If p_target(y_i) >= p_draft(y_i): accept y_i (draft got it right)
     - Else: reject with probability 1 - p_target(y_i)/p_draft(y_i)
     - If rejected: resample from adjusted distribution and stop
   
4. **Continue:**
   - If all K tokens accepted: generate K+1 from M_target, continue draft
   - If rejected at position j: continue from j+1

### Why This Preserves Distribution

The acceptance/rejection sampling ensures that the final output distribution matches exactly what you'd get from sampling M_target directly. This is proven using importance sampling theory.

**Key insight:** When the draft model is "right," you get free speedup. When it's "wrong," you fall back to the target model with minimal overhead.

## Mathematical Foundation

Let p(x) be the target distribution and q(x) be the draft distribution.

**Acceptance probability:**
```
A(x) = min(1, p(x) / q(x))
```

**Sampling procedure:**
1. Sample x ~ q(x)
2. Sample u ~ Uniform(0, 1)
3. If u < A(x), accept x; else reject and resample

This produces samples distributed according to p(x).

**Speculative decoding applies this token-by-token:**
- Draft model proposes: y ~ q(y | context)
- Target model evaluates: p(y | context)
- Accept with probability A(y) = min(1, p(y)/q(y))

## Implementation Example

```python
def speculative_decode(target_model, draft_model, prompt, K=5, max_tokens=100):
    """
    Speculative decoding with K-token lookahead
    """
    tokens = prompt.copy()
    
    while len(tokens) < max_tokens:
        # Phase 1: Draft K tokens
        draft_tokens = []
        draft_probs = []
        draft_context = tokens.copy()
        
        for _ in range(K):
            draft_logits = draft_model(draft_context)
            draft_prob = softmax(draft_logits)
            draft_token = sample(draft_prob)
            
            draft_tokens.append(draft_token)
            draft_probs.append(draft_prob[draft_token])
            draft_context.append(draft_token)
        
        # Phase 2: Verify all K tokens in parallel with target model
        target_logits = target_model(tokens + draft_tokens)  # Single forward pass!
        
        # Phase 3: Accept/reject each token
        accepted = 0
        for i, draft_token in enumerate(draft_tokens):
            target_prob = softmax(target_logits[len(tokens) + i])
            
            # Acceptance probability
            accept_prob = min(1.0, target_prob[draft_token] / draft_probs[i])
            
            if random.random() < accept_prob:
                tokens.append(draft_token)
                accepted += 1
            else:
                # Rejection: resample from adjusted distribution
                adjusted_prob = max(0, target_prob - draft_probs[i])
                adjusted_prob /= adjusted_prob.sum()
                new_token = sample(adjusted_prob)
                tokens.append(new_token)
                break  # Stop after first rejection
        
        # If all accepted, add one bonus token from target
        if accepted == K:
            bonus_logits = target_model(tokens)
            tokens.append(sample(softmax(bonus_logits)))
    
    return tokens
```

## Tradeoffs & Limitations

### Pros
✅ **2-3x speedup** on typical generations  
✅ **Zero quality loss** (distribution is mathematically identical)  
✅ **No retraining** required (works with any draft/target pair)  
✅ **Graceful degradation** (if draft is terrible, falls back to target speed)

### Cons
❌ **Requires draft model** (extra memory overhead)  
❌ **Speedup varies** (depends on draft accuracy)  
❌ **Batch size conflicts** (harder to batch multiple requests efficiently)  
❌ **Memory pressure** (need both models loaded)

### When It Works Best
- **Long generations:** More opportunities to amortize verification cost
- **Predictable text:** Code, structured data, formal writing (draft accuracy is high)
- **Good draft models:** When draft is 80%+ accurate, speedup is maximized

### When It Struggles
- **Short responses:** Overhead dominates (not worth it for 1-2 tokens)
- **Creative/unpredictable text:** Draft rarely matches target
- **Batch serving:** Harder to parallelize across users

## Real-World Usage

### Implementations
- **Hugging Face Transformers:** `assisted_generation` parameter
- **vLLM:** Native speculative decoding support (v0.2.0+)
- **TensorRT-LLM:** Medusa-style multi-head speculation
- **llama.cpp:** Draft model mode

### Performance Benchmarks
| Model Pair | Task | Speedup |
|------------|------|---------|
| Llama-70B + Llama-7B | Code gen | 2.9x |
| GPT-4 + GPT-3.5 | Long-form writing | 2.1x |
| Mixtral-8x7B + Mistral-7B | QA | 2.5x |

### Production Considerations
- Draft model should be ~10x smaller (e.g., 70B + 7B, or 7B + 1B)
- K=4-6 is sweet spot (higher K = diminishing returns)
- Works best with same architecture family (Llama + Llama, not Llama + GPT)

## Key Papers

1. **Original paper:**  
   "Fast Inference from Transformers via Speculative Decoding"  
   Leviathan et al., 2023 (arXiv:2211.17192)

2. **Theoretical foundations:**  
   "Accelerating Large Language Model Decoding with Speculative Sampling"  
   Chen et al., 2023 (arXiv:2302.01318)

3. **Medusa (multi-head variant):**  
   "Medusa: Simple LLM Inference Acceleration with Multiple Decoding Heads"  
   Cai et al., 2024 (arXiv:2401.10774)

## Related Concepts

### Prerequisites
- **Autoregressive generation:** Understand why LLMs are slow (sequential token generation)
- **Sampling methods:** Temperature, top-p, top-k
- **Importance sampling:** Statistical technique for distribution matching

### Extensions
- **Medusa:** Instead of separate draft model, add lightweight prediction heads to target model
- **Tree-based speculation:** Generate multiple draft paths in parallel, verify tree
- **Self-speculation:** Use earlier layers of target model as draft

### Alternatives
- **Model distillation:** Train smaller model to mimic large one (faster but lower quality)
- **Quantization:** Reduce model precision (faster but quality tradeoff)
- **Prompt caching:** Reuse KV cache for repeated prefixes (orthogonal optimization)

---

**Feedback:** Was this helpful?  
Reply `/feedback deep-dive helpful` or `/feedback deep-dive too-complex`
```

**Length:** ~1,150 words  
**Delivery:** On-demand (Mikey explicitly requests `/learn speculative-decoding --type deep_dive`)  
**Read time:** ~6 minutes

---

## Format: ELI12 (Explain Like I'm 12)

```
# Speculative Decoding - Explained for a Smart 12-Year-Old

Imagine you're playing a video game where an AI predicts your next moves to make the game run smoother.

**Here's the problem:**
Big, smart AI models (like ChatGPT) are really slow because they think about one word at a time. They can't think ahead—they have to wait to see what word they just wrote before picking the next one. It's like writing an essay where you have to wait 2 seconds after every single word. Painful!

**The solution:**
What if we had a "guesser" AI that's really fast but not as smart? It could quickly guess the next few words, and then the big smart AI just checks if those guesses are good.

**How it works:**
1. Fast AI (the "drafter"): "I bet the next 5 words are: the cat sat on the"
2. Smart AI (the "checker"): Looks at all 5 words at once and says "Yep, I would've written exactly that!"
3. Boom! You just got 5 words in the time it usually takes to write 1.

**When it doesn't work:**
Sometimes the fast AI guesses wrong:
- Fast AI: "the cat sat on the moon"
- Smart AI: "Nah, I would've said 'mat,' not 'moon'"
- Smart AI fixes it and keeps going

**Why is this cool?**
It makes AI 2-3 times faster without any loss in quality! The smart AI still makes all the final decisions—the fast AI just helps it skip boring, obvious words.

**Real example:**
When you're coding and your AI helps you write a function, speculative decoding lets it write common patterns (like `for i in range(10):`) super fast, while still being careful with the tricky logic.

It's like having a friend who shouts out answers during a test—sometimes they're right and you save time, sometimes they're wrong and you ignore them. Either way, you never do worse than working alone!
```

**Length:** ~320 words  
**Delivery:** On-demand (Mikey requests `/explain speculative-decoding eli12`)  
**Read time:** ~90 seconds  
**Use case:** When Mikey wants a quick, intuitive understanding without technical depth

---

## Design Notes

### Tone & Style
- **Quick Context:** Conversational, practical, "coffee chat with a colleague"
- **Deep Dive:** Technical but accessible, comprehensive, reference-quality
- **ELI12:** Playful, concrete analogies, focuses on intuition over precision

### Delivery Contexts
1. **In-digest (Quick Context only):**
   - Appears BEFORE papers that mention the concept
   - Max 2 lessons per digest to avoid overwhelm

2. **On-demand (any format):**
   - Mikey explicitly requests `/learn <concept> --type <format>`
   - Immediate delivery via Signal or CLI

3. **Weekly recap (summary format):**
   - "This week you learned: X, Y, Z"
   - Links to deep dives for each

### Feedback Loops
After each lesson, Mikey can:
- `/understood <concept>` → Mark as learned
- `/feedback helpful` → Positive signal
- `/feedback too-complex` → Future lessons simplify
- `/feedback want-more` → Queue deep dive

### Adaptive Difficulty
Track feedback over time:
- 3+ "too simple" → Default to deeper explanations
- 3+ "too complex" → Default to ELI12 style
- Customize per topic (Mikey might want ELI12 for math, engineer-level for code)

---

This example demonstrates the gap detector's core value: **turning confusion into curriculum**. Every knowledge gap becomes a structured learning opportunity, delivered at the moment it's most relevant.
