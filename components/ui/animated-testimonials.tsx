"use client";

import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

export type Testimonial = {
  quote: string;
  name: string;
  designation: string;
  src: string;
};

/**
 * 셔플 카드 캐러셀. 뒤쪽 카드가 흩어져 쌓이고 활성 카드가 앞으로 나온다.
 *
 * 회전값은 인덱스로 고정한다. Math.random()을 쓰면 서버 렌더와 클라이언트 렌더가
 * 달라져 hydration 경고가 난다.
 */
const ROTATIONS = [-9, 6, -4, 8, -7, 5, -6, 9];

export const AnimatedTestimonials = ({
  testimonials,
  autoplay = false,
  interval = 6000,
}: {
  testimonials: Testimonial[];
  autoplay?: boolean;
  interval?: number;
}) => {
  const [active, setActive] = useState(0);

  const handleNext = useCallback(() => {
    setActive((prev) => (prev + 1) % testimonials.length);
  }, [testimonials.length]);

  const handlePrev = useCallback(() => {
    setActive((prev) => (prev - 1 + testimonials.length) % testimonials.length);
  }, [testimonials.length]);

  useEffect(() => {
    if (!autoplay) return;
    const id = setInterval(handleNext, interval);
    return () => clearInterval(id);
  }, [autoplay, interval, handleNext]);

  const isActive = (index: number) => index === active;

  return (
    <div className="mt-4 font-sans antialiased">
      <div className="relative grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,22rem)_1fr]">
        <div>
          <div className="relative h-80 w-full">
            <AnimatePresence>
              {testimonials.map((testimonial, index) => (
                <motion.div
                  key={testimonial.src + index}
                  initial={{
                    opacity: 0,
                    scale: 0.9,
                    z: -100,
                    rotate: ROTATIONS[index % ROTATIONS.length],
                  }}
                  animate={{
                    opacity: isActive(index) ? 1 : 0.7,
                    scale: isActive(index) ? 1 : 0.95,
                    z: isActive(index) ? 0 : -100,
                    rotate: isActive(index)
                      ? 0
                      : ROTATIONS[index % ROTATIONS.length],
                    zIndex: isActive(index)
                      ? 40
                      : testimonials.length + 2 - index,
                    y: isActive(index) ? [0, -60, 0] : 0,
                  }}
                  exit={{
                    opacity: 0,
                    scale: 0.9,
                    z: 100,
                    rotate: ROTATIONS[index % ROTATIONS.length],
                  }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                  className="case absolute inset-0 origin-bottom overflow-hidden p-1.5"
                >
                  <Image
                    src={testimonial.src}
                    alt={testimonial.name}
                    width={500}
                    height={500}
                    draggable={false}
                    className="h-full w-full rounded-sm object-cover object-center opacity-95"
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex flex-col justify-between py-4">
          <motion.div
            key={active}
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -20, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
          >
            <h3 className="engraved text-3xl font-black">
              {testimonials[active].name}
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-tung/70">
              {testimonials[active].designation}
            </p>
            <motion.p className="mt-7 text-[15px] leading-[1.8] text-dust">
              {testimonials[active].quote.split(" ").map((word, index) => (
                <motion.span
                  key={index}
                  initial={{ filter: "blur(10px)", opacity: 0, y: 5 }}
                  animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.2,
                    ease: "easeInOut",
                    delay: 0.02 * index,
                  }}
                  className="inline-block"
                >
                  {word}&nbsp;
                </motion.span>
              ))}
            </motion.p>
          </motion.div>

          <div className="flex gap-4 pt-12 md:pt-0">
            <button
              type="button"
              onClick={handlePrev}
              aria-label="이전 카드"
              className="case case-live group/button flex h-9 w-9 items-center justify-center"
            >
              <Arrow className="h-4 w-4 text-grime transition-all duration-300 group-hover/button:-translate-x-0.5 group-hover/button:text-tung" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              aria-label="다음 카드"
              className="case case-live group/button flex h-9 w-9 items-center justify-center"
            >
              <Arrow className="h-4 w-4 rotate-180 text-grime transition-all duration-300 group-hover/button:translate-x-0.5 group-hover/button:text-tung" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function Arrow({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M5 12l6 6M5 12l6-6" />
    </svg>
  );
}
